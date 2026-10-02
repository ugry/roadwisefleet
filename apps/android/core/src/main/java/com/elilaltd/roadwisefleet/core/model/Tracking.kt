package com.elilaltd.roadwisefleet.core.model

import java.util.UUID

/**
 * Background-location rules (board #106, AND1-A4) — the pure core of the
 * tracking feature, mirroring `apps/api/src/gps-ingest.js`.
 *
 * Owner constraint (2026-10-01): the 10-minute cadence is confirmed, but the app
 * must not drain the battery. So sampling runs **only while a trip's `tracking`
 * flag is true** (set by Start Trip, cleared at DELIVERED): there is no
 * always-on service. The battery-conscious profile is recorded in
 * `docs/android-architecture.md` §10.
 *
 * Kept free of Android types (no `Location`, no `Context`, no JSON) so the JVM
 * tests in `core/src/test` pin the cadence, the validation and the batch shape
 * without a device.
 */
enum class TrackingPhase { ACTIVE, NOT_STARTED, STOPPED }

/** One GPS sample as the app stores and uploads it. */
data class GpsSample(
    val clientId: String,
    val tripId: String,
    val atEpochMs: Long,
    val lat: Double,
    val lng: Double,
    val accuracyM: Int?,
)

/** Validation of a raw platform fix. [Invalid.detailKey] is a catalogue key. */
sealed interface SampleResult {
    data class Ok(val sample: GpsSample) : SampleResult
    data class Invalid(val detailKey: String) : SampleResult
}

object TrackingCore {
    /** One sample every 10 minutes — the owner-confirmed cadence. */
    const val SAMPLE_INTERVAL_MS = 10L * 60L * 1000L

    /** The server's per-request cap (`GPS_MAX_BATCH` in gps-ingest.js). */
    const val MAX_BATCH_SIZE = 200

    /** A fix this far in the future is a clock problem, not skew. */
    const val MAX_FUTURE_SKEW_MS = 10L * 60L * 1000L

    /** Accuracy beyond this is unusable for tracking. */
    const val MAX_ACCURACY_M = 100_000

    /**
     * WorkManager's periodic floor is 15 minutes, which is why the 10-minute
     * cadence needs the foreground service and the worker only flushes/retries.
     */
    const val FLUSH_INTERVAL_MINUTES = 15L

    /**
     * Where a trip sits relative to tracking.
     *
     * `ACTIVE` needs both the server-side gate ([tracking]) and a status that is
     * still an *active assignment*. The server clears `tracking` at `DELIVERED`
     * (owner decision, board #106), and `DELIVERED` is not terminal — it
     * transitions on to `POD_UPLOADED` — so a stale local `true` must read
     * `STOPPED`, never keep sampling. `isTerminal` still closes genuinely
     * finished trips (`SETTLED`, `CANCELLED`).
     */
    fun phaseFor(tracking: Boolean, status: String): TrackingPhase = when {
        TripStatus.isTerminal(status) -> TrackingPhase.STOPPED
        !TripStatus.isActiveAssignment(status) -> TrackingPhase.STOPPED
        tracking -> TrackingPhase.ACTIVE
        else -> TrackingPhase.NOT_STARTED
    }

    /** The one trip the tracking service should follow, or null. */
    fun activeTrip(trips: List<Trip>): Trip? =
        trips.firstOrNull { phaseFor(it.tracking, it.status) == TrackingPhase.ACTIVE }

    /**
     * True when the next sample is due. A 10-minute cadence is a *minimum*
     * interval, so a late/duplicate fix is fine and one that arrives early is not
     * sampled twice.
     */
    fun isSampleDue(nowEpochMs: Long, lastSampleEpochMs: Long?): Boolean =
        lastSampleEpochMs == null || nowEpochMs - lastSampleEpochMs >= SAMPLE_INTERVAL_MS

    /**
     * Validate one fix before it is stored. Rejects the same things the server
     * does, so a bad point never enters the offline queue (where it would poison
     * the whole batch on upload).
     */
    fun normalizeSample(
        tripId: String,
        clientId: String,
        lat: Double,
        lng: Double,
        atEpochMs: Long,
        accuracyM: Int?,
        nowEpochMs: Long,
    ): SampleResult {
        if (tripId.isBlank()) return SampleResult.Invalid("tracking.tripRequired")
        if (clientId.isBlank()) return SampleResult.Invalid("tracking.idRequired")
        if (lat < -90.0 || lat > 90.0) return SampleResult.Invalid("tracking.latRange")
        if (lng < -180.0 || lng > 180.0) return SampleResult.Invalid("tracking.lngRange")
        if (atEpochMs > nowEpochMs + MAX_FUTURE_SKEW_MS) return SampleResult.Invalid("tracking.futureTimestamp")
        if (accuracyM != null && (accuracyM < 0 || accuracyM > MAX_ACCURACY_M)) {
            return SampleResult.Invalid("tracking.accuracy")
        }
        return SampleResult.Ok(GpsSample(clientId, tripId, atEpochMs, lat, lng, accuracyM))
    }

    /** Split unsent points into server-sized batches, oldest first. */
    fun chunkForUpload(samples: List<GpsSample>, max: Int = MAX_BATCH_SIZE): List<List<GpsSample>> =
        if (max < 1) emptyList() else samples.chunked(max)

    /** A stable id for one sample; the server uses it to make replays idempotent. */
    fun newClientId(): String = UUID.randomUUID().toString()
}
