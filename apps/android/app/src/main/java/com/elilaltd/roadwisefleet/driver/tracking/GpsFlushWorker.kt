package com.elilaltd.roadwisefleet.driver.tracking

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.elilaltd.roadwisefleet.driver.RoadwiseApp

/**
 * Drains the GPS queue (board #106, AND1-A4). WorkManager gives the retry and
 * the network constraint; the batching and idempotency live in
 * [com.elilaltd.roadwisefleet.core.data.repo.TrackingRepository].
 *
 * A `409 tracking_off` means the trip's tracking window has ended, so tracking
 * is stopped instead of retried. Anything else that fails (offline, 5xx) is
 * retried with backoff — no point is ever dropped.
 */
class GpsFlushWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val container = (applicationContext as RoadwiseApp).container
        return try {
            val outcome = container.trackingRepository.flush()
            if (outcome.trackingOff) {
                TrackingScheduler.stop(applicationContext)
                Result.success()
            } else if (outcome.failed > 0) {
                Result.retry()
            } else {
                Result.success()
            }
        } catch (_: Throwable) {
            Result.retry()
        }
    }
}
