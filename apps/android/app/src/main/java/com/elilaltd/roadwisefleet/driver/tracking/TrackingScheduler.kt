package com.elilaltd.roadwisefleet.driver.tracking

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.elilaltd.roadwisefleet.core.model.TrackingCore
import java.util.concurrent.TimeUnit

/**
 * Starts/stops the tracking window and owns the flush schedule (board #106,
 * AND1-A4).
 *
 * `start` starts the foreground service (which does the 10-minute sampling) and
 * registers a 15-minute periodic WorkManager flush (the platform floor); `stop`
 * stops both. A one-shot flush is enqueued whenever a point is stored or the
 * device boots, so a reconnect drains the queue quickly without waking the
 * radio on a timer.
 */
object TrackingScheduler {
    const val EXTRA_TRIP_ID = "tripId"

    private const val FLUSH_UNIQUE = "roadwisefleet.gps.flush"
    private const val FLUSH_NOW_UNIQUE = "roadwisefleet.gps.flush.now"

    /** Begin tracking for one trip: foreground sampling + periodic flush. */
    fun start(context: Context, tripId: String) {
        TrackingStateStore.setActive(context, tripId)
        val intent = Intent(context, LocationTrackingService::class.java)
            .putExtra(EXTRA_TRIP_ID, tripId)
        ContextCompat.startForegroundService(context, intent)
        enqueuePeriodicFlush(context)
    }

    /** End tracking entirely (trip delivered / tracking flag off). */
    fun stop(context: Context) {
        TrackingStateStore.clear(context)
        context.stopService(Intent(context, LocationTrackingService::class.java))
        val work = WorkManager.getInstance(context)
        work.cancelUniqueWork(FLUSH_UNIQUE)
        work.cancelUniqueWork(FLUSH_NOW_UNIQUE)
    }

    /** Flush the offline queue as soon as the network allows. */
    fun enqueueFlush(context: Context) {
        val request = OneTimeWorkRequestBuilder<GpsFlushWorker>()
            .setConstraints(connected())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context)
            .enqueueUniqueWork(FLUSH_NOW_UNIQUE, ExistingWorkPolicy.KEEP, request)
    }

    private fun enqueuePeriodicFlush(context: Context) {
        val request = PeriodicWorkRequestBuilder<GpsFlushWorker>(
            TrackingCore.FLUSH_INTERVAL_MINUTES,
            TimeUnit.MINUTES,
        )
            .setConstraints(connected())
            .build()
        WorkManager.getInstance(context)
            .enqueueUniquePeriodicWork(FLUSH_UNIQUE, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    private fun connected(): Constraints =
        Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
}
