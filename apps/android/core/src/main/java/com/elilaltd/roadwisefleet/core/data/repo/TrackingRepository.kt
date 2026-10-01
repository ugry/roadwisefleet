package com.elilaltd.roadwisefleet.core.data.repo

import com.elilaltd.roadwisefleet.core.data.local.GpsPointDao
import com.elilaltd.roadwisefleet.core.data.local.GpsPointEntity
import com.elilaltd.roadwisefleet.core.data.remote.ApiClient
import com.elilaltd.roadwisefleet.core.data.remote.ApiResult
import com.elilaltd.roadwisefleet.core.model.GpsSample
import com.elilaltd.roadwisefleet.core.model.TrackingCore
import org.json.JSONArray
import org.json.JSONObject

/** Outcome of one flush pass (board #106, AND1-A4). */
data class FlushOutcome(
    val uploaded: Int,
    val failed: Int,
    val batches: Int,
    val trackingOff: Boolean,
)

/**
 * The offline GPS queue (board #106, AND1-A4).
 *
 * Points sampled by the foreground service are written to Room (`gps_points`)
 * and uploaded by [flush] in server-sized batches, oldest first. A batch is
 * marked uploaded only after the API accepts it, so a dropped connection loses
 * nothing; the client id makes the eventual replay idempotent server-side.
 *
 * A `409 tracking_off` is terminal: the trip's tracking flag is off (delivered
 * or cancelled), so sampling must stop rather than retry forever. The caller
 * ([com.elilaltd.roadwisefleet.driver.tracking.GpsFlushWorker]) reacts by
 * stopping the service.
 */
class TrackingRepository(
    private val api: ApiClient,
    private val gpsDao: GpsPointDao,
) {
    /** Persist one validated sample. A duplicate client id is ignored. */
    suspend fun record(sample: GpsSample) {
        gpsDao.insert(
            GpsPointEntity(
                clientId = sample.clientId,
                tripId = sample.tripId,
                atEpochMs = sample.atEpochMs,
                lat = sample.lat,
                lng = sample.lng,
                accuracyM = sample.accuracyM,
                uploaded = false,
            ),
        )
    }

    suspend fun pendingCount(): Int = gpsDao.pendingCount()

    /** The last sampled instant for a trip, for the 10-minute cadence gate. */
    suspend fun lastSampleAt(tripId: String): Long? = gpsDao.lastSampleAt(tripId)

    /**
     * Upload everything unsent. Stops at the first failure so the queue keeps
     * its order and the retry is a clean replay.
     */
    suspend fun flush(): FlushOutcome {
        val pending = gpsDao.unsent()
        if (pending.isEmpty()) return FlushOutcome(uploaded = 0, failed = 0, batches = 0, trackingOff = false)

        var uploaded = 0
        var failed = 0
        var batches = 0
        var trackingOff = false

        // Group by trip: the endpoint is per-trip, and grouping keeps a single
        // trip's points in time order.
        for ((tripId, rows) in pending.groupBy { it.tripId }) {
            val samples = rows.map {
                GpsSample(it.clientId, it.tripId, it.atEpochMs, it.lat, it.lng, it.accuracyM)
            }
            for (batch in TrackingCore.chunkForUpload(samples)) {
                batches += 1
                when (val result = api.postGps(tripId, batchJson(batch))) {
                    is ApiResult.Ok -> {
                        gpsDao.markUploaded(batch.map { it.clientId })
                        uploaded += batch.size
                    }
                    is ApiResult.HttpFailure -> {
                        failed += batch.size
                        if (result.status == 409 && result.error == "tracking_off") trackingOff = true
                        if (uploaded > 0) gpsDao.purgeUploaded()
                        return FlushOutcome(uploaded, failed, batches, trackingOff)
                    }
                    is ApiResult.NetworkFailure -> {
                        failed += batch.size
                        if (uploaded > 0) gpsDao.purgeUploaded()
                        return FlushOutcome(uploaded, failed, batches, trackingOff)
                    }
                }
            }
        }
        if (uploaded > 0) gpsDao.purgeUploaded()
        return FlushOutcome(uploaded, failed, batches, trackingOff)
    }

    private fun batchJson(batch: List<GpsSample>): String {
        val points = JSONArray()
        for (sample in batch) {
            val point = JSONObject()
                .put("id", sample.clientId)
                .put("at", sample.atEpochMs)
                .put("lat", sample.lat)
                .put("lng", sample.lng)
            sample.accuracyM?.let { point.put("accuracyM", it) }
            points.put(point)
        }
        return JSONObject().put("points", points).toString()
    }
}
