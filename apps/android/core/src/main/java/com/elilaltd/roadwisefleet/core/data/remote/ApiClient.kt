package com.elilaltd.roadwisefleet.core.data.remote

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
) {
    suspend fun driverTrips(): ApiResult<List<Trip>> =
        request("GET", "/api/driver/trips", null).map { body -> parseTrips(body) }

    suspend fun postStatus(tripId: String, to: String): ApiResult<Unit> =
        request("POST", "/api/trips/$tripId/status", JSONObject().put("status", to).toString()).map { }

    suspend fun postDocument(tripId: String, payloadJson: String): ApiResult<Unit> =
        request("POST", "/api/trips/$tripId/documents", payloadJson).map { }

    suspend fun postSos(payloadJson: String): ApiResult<Unit> =
        request("POST", "/api/driver/sos", payloadJson).map { }

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
            updatedAtEpochMs = parseEpochMs(source.opt("updatedAt")),
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
