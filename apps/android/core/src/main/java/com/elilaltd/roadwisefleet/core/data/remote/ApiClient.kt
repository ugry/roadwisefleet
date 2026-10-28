package com.elilaltd.roadwisefleet.core.data.remote

import com.elilaltd.roadwisefleet.core.auth.AuthApi
import com.elilaltd.roadwisefleet.core.model.AuthUser
import com.elilaltd.roadwisefleet.core.model.DeviceChallenge
import com.elilaltd.roadwisefleet.core.model.DeviceRegistration
import com.elilaltd.roadwisefleet.core.model.DeviceSession
import com.elilaltd.roadwisefleet.core.model.PasswordLogin
import com.elilaltd.roadwisefleet.core.model.Trip
import com.elilaltd.roadwisefleet.core.model.TripDocument
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Result of one API call. Network failures are distinct from HTTP failures. */
sealed interface ApiResult<out T> {
    data class Ok<T>(val value: T) : ApiResult<T>
    data class HttpFailure(val status: Int, val error: String) : ApiResult<Nothing>
    data class NetworkFailure(val message: String) : ApiResult<Nothing>
}

inline fun <T, R> ApiResult<T>.map(transform: (T) -> R): ApiResult<R> = when (this) {
    is ApiResult.Ok -> ApiResult.Ok(transform(value))
    is ApiResult.HttpFailure -> this
    is ApiResult.NetworkFailure -> this
}

/**
 * Minimal HTTP client for the driver endpoints (board #103, AND1-A1). Standard
 * `HttpURLConnection` on `Dispatchers.IO` — no third-party stack, so the
 * scaffold's dependency surface stays small. The bearer token is provided per
 * call and never logged.
 */
class ApiClient(
    private val baseUrl: String,
    private val tokenProvider: () -> String?,
) : AuthApi {
    suspend fun driverTrips(): ApiResult<List<Trip>> =
        request("GET", "/api/driver/trips", null).map { body -> parseTrips(body) }

    suspend fun postStatus(tripId: String, to: String): ApiResult<Unit> =
        request("POST", "/api/trips/$tripId/status", JSONObject().put("status", to).toString()).map { }

    /**
     * Start Trip (board #105): the dedicated driver action that moves
     * ASSIGNED → EN_ROUTE and turns live GPS tracking on. Distinct from
     * [postStatus] on purpose — only this endpoint flips the tracking flag.
     */
    suspend fun startTrip(tripId: String): ApiResult<Unit> =
        request("POST", "/api/trips/$tripId/start", "{}").map { }

    suspend fun postDocument(tripId: String, payloadJson: String): ApiResult<Unit> =
        request("POST", "/api/trips/$tripId/documents", payloadJson).map { }

    /**
     * Board #106 (AND1-A4): upload one batch of sampled GPS points while the
     * trip is tracking. `batchJson` is `{ "points": [...] }`, already assembled
     * by the tracking repository; the server dedupes on the client point id, so
     * a replayed batch is safe.
     */
    suspend fun postGps(tripId: String, batchJson: String): ApiResult<Unit> =
        request("POST", "/api/trips/$tripId/gps", batchJson).map { }

    suspend fun postSos(payloadJson: String): ApiResult<Unit> =
        request("POST", "/api/driver/sos", payloadJson).map { }

    // --- passwordless device auth (board #104, AND1-A2) ---------------------

    /**
     * Bind this device's public key to the signed-in driver (first login). The
     * caller passes the base64 SPKI public key from the Keystore — never a
     * private key.
     */
    override suspend fun registerDevice(
        publicKeyBase64: String,
        algorithm: String,
        deviceLabel: String?,
    ): ApiResult<DeviceRegistration> {
        val body = JSONObject()
            .put("publicKey", publicKeyBase64)
            .put("algorithm", algorithm)
            .put("deviceLabel", deviceLabel ?: JSONObject.NULL)
        return request("POST", "/api/auth/device/register", body.toString()).map { response ->
            val credential = JSONObject(response).getJSONObject("credential")
            DeviceRegistration(
                credentialId = credential.getString("id"),
                algorithm = credential.optString("algorithm", algorithm),
                deviceLabel = credential.nullableString("deviceLabel"),
            )
        }
    }

    /** Ask for a single-use nonce to sign (no password). */
    override suspend fun deviceChallenge(credentialId: String): ApiResult<DeviceChallenge> {
        val body = JSONObject().put("credentialId", credentialId)
        return request("POST", "/api/auth/device/challenge", body.toString()).map { response ->
            val json = JSONObject(response)
            DeviceChallenge(
                challengeId = json.getString("challengeId"),
                nonce = json.getString("nonce"),
                algorithm = json.optString("algorithm", "ES256"),
            )
        }
    }

    /** Exchange a signature over the nonce for a session token. */
    override suspend fun deviceVerify(challengeId: String, signatureBase64: String): ApiResult<DeviceSession> {
        val body = JSONObject().put("challengeId", challengeId).put("signature", signatureBase64)
        return request("POST", "/api/auth/device/verify", body.toString()).map { response ->
            val json = JSONObject(response)
            DeviceSession(
                token = json.getString("token"),
                userId = json.getJSONObject("user").getString("id"),
                deviceCredentialId = json.getJSONObject("user").nullableString("deviceCredentialId"),
            )
        }
    }

    // --- password login + sign-out revoke (board #104 reopen) ----------------

    /**
     * Email + password login. The response carries the same token shape as a
     * device `verify`, so the caller treats both paths identically.
     */
    override suspend fun login(email: String, password: String): ApiResult<PasswordLogin> {
        val body = JSONObject().put("email", email).put("password", password)
        return request("POST", "/api/auth/login", body.toString()).map(::parseLogin)
    }

    // --- email one-time codes (board #125) -----------------------------------

    /**
     * Ask the server to mail a 6-digit sign-in code. The response is deliberately
     * generic on the server (no account enumeration), so the app always enters
     * the code screen and offers a resend after the server's 60 s gap.
     */
    override suspend fun requestEmailCode(email: String): ApiResult<Unit> {
        val body = JSONObject().put("email", email)
        return request("POST", "/api/auth/otp/email/request", body.toString()).map { }
    }

    /** Redeem the emailed code; success carries the same shape as [login]. */
    override suspend fun verifyEmailCode(email: String, code: String): ApiResult<PasswordLogin> {
        val body = JSONObject().put("email", email).put("code", code)
        return request("POST", "/api/auth/otp/email/verify", body.toString()).map(::parseLogin)
    }

    /** Whether the server has an email sender configured (fails open = true). */
    override suspend fun emailOtpAvailable(): ApiResult<Boolean> =
        request("GET", "/api/auth/otp/email/status", null).map { response ->
            JSONObject(response).optBoolean("configured", true)
        }

    /**
     * The `{ token, user }` payload shared by `/auth/login` and
     * `/auth/otp/email/verify` — one parser, so the two paths cannot drift.
     */
    private fun parseLogin(response: String): PasswordLogin {
        val json = JSONObject(response)
        val user = json.getJSONObject("user")
        return PasswordLogin(
            token = json.getString("token"),
            user = AuthUser(
                id = user.getString("id"),
                name = user.optString("name"),
                roleId = user.optString("roleId"),
                orgId = user.nullableString("orgId"),
                locale = user.nullableString("locale"),
                lang = user.nullableString("lang"),
            ),
        )
    }

    /**
     * Revoke this device on sign-out (best effort). The route requires the
     * current bearer token, so the caller must invoke it BEFORE clearing the
     * session.
     */
    /**
     * Delete the signed-in account (board #142, Play requirement). The route
     * needs the CURRENT bearer token, so the caller must not clear the session
     * first; it returns the retention statement, which the UI shows.
     */
    override suspend fun deleteAccount(): ApiResult<Unit> =
        request("DELETE", "/api/account", null).map { }

    override suspend fun revokeDevice(credentialId: String): ApiResult<Unit> {
        val body = JSONObject().put("credentialId", credentialId)
        return request("POST", "/api/auth/device/revoke", body.toString()).map { }
    }

    private suspend fun request(method: String, path: String, body: String?): ApiResult<String> =
        withContext(Dispatchers.IO) {
            var connection: HttpURLConnection? = null
            try {
                connection = (URL(baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection).apply {
                    requestMethod = method
                    connectTimeout = 15_000
                    readTimeout = 20_000
                    setRequestProperty("Accept", "application/json")
                    setRequestProperty("X-Client", CLIENT_TAG)
                    tokenProvider()?.let { setRequestProperty("Authorization", "Bearer $it") }
                    if (body != null) {
                        doOutput = true
                        setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    }
                }
                if (body != null) {
                    connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                }
                val status = connection.responseCode
                val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                val text = stream?.bufferedReader()?.use { reader -> reader.readText() }.orEmpty()
                if (status in 200..299) ApiResult.Ok(text) else ApiResult.HttpFailure(status, extractError(text))
            } catch (t: Throwable) {
                ApiResult.NetworkFailure(t.message ?: t.javaClass.simpleName)
            } finally {
                connection?.disconnect()
            }
        }

    private fun parseTrips(body: String): List<Trip> {
        val root = JSONObject(body)
        val array = root.optJSONArray("trips") ?: JSONArray()
        return (0 until array.length()).mapNotNull { index -> array.optJSONObject(index)?.let(::parseTrip) }
    }

    private fun parseTrip(source: JSONObject): Trip {
        val order = source.optJSONObject("order")
        val truck = source.optJSONObject("truck")
        val customer = order?.optJSONObject("customer")
        val documents = source.optJSONArray("documents")
        return Trip(
            id = source.optString("id"),
            status = source.optString("status", "DRAFT"),
            origin = order.nullableString("origin"),
            destination = order.nullableString("destination"),
            cargo = order.nullableString("cargo"),
            customer = customer.nullableString("name"),
            truckPlate = truck.nullableString("plate"),
            rateEur = source.nullableDouble("rateEur"),
            updatedAtEpochMs = parseEpochMs(source.opt("updatedAt")) ?: 0L,
            // Board #106: the driver app starts/stops the tracking service from
            // this flag (set by Start Trip server-side, cleared at DELIVERED).
            tracking = source.optBoolean("tracking", false),
            documents = (0 until (documents?.length() ?: 0)).mapNotNull { index ->
                documents?.optJSONObject(index)?.let { doc ->
                    TripDocument(
                        id = doc.optString("id"),
                        docType = doc.optString("docType"),
                        status = doc.optString("status"),
                        uploadedAtEpochMs = parseEpochMs(doc.opt("uploadedAt")),
                    )
                }
            },
        )
    }

    private fun extractError(body: String): String =
        try {
            JSONObject(body).optString("error").ifBlank { "http_error" }
        } catch (t: Throwable) {
            "http_error"
        }

    companion object {
        const val CLIENT_TAG = "roadwisefleet-android/0.1.0-a1"
    }
}

private fun JSONObject?.nullableString(name: String): String? {
    if (this == null || !has(name) || isNull(name)) return null
    return optString(name).ifBlank { null }
}

private fun JSONObject?.nullableDouble(name: String): Double? {
    if (this == null || !has(name) || isNull(name)) return null
    val value = optDouble(name, Double.NaN)
    return if (value.isNaN()) null else value
}

/**
 * Accepts epoch millis or an ISO-8601 string; returns null when unusable.
 *
 * Deliberately not `java.time`: minSdk is 24 and java.time needs API 26 (or
 * core-library desugaring), so the scaffold parses with `SimpleDateFormat`.
 */
private fun parseEpochMs(value: Any?): Long? = when (value) {
    null, JSONObject.NULL -> null
    is Number -> value.toLong()
    is String -> value.toLongOrNull() ?: parseIso(value)
    else -> null
}

private val ISO_PATTERNS = listOf(
    "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
    "yyyy-MM-dd'T'HH:mm:ssXXX",
    "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
    "yyyy-MM-dd'T'HH:mm:ss'Z'",
)

private fun parseIso(value: String): Long? {
    for (pattern in ISO_PATTERNS) {
        val parsed = runCatching {
            java.text.SimpleDateFormat(pattern, java.util.Locale.US)
                .apply { isLenient = false }
                .parse(value)
        }.getOrNull()
        if (parsed != null) return parsed.time
    }
    return null
}
