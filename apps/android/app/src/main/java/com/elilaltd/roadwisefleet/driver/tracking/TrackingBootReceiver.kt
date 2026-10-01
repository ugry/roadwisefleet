package com.elilaltd.roadwisefleet.driver.tracking

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Boot-resume for tracking (board #106, AND1-A4).
 *
 * A foreground service cannot survive a reboot, so the active trip id is kept in
 * [TrackingStateStore]; on boot the receiver restarts the tracking window for
 * that trip (if location is still permitted). If the trip ended while the phone
 * was off, the first flush returns `409 tracking_off` and the worker stops
 * tracking — so an ended trip is never resumed indefinitely. With no active
 * trip, it only drains any queued points.
 *
 * From Android 12 the system may refuse a foreground-service start from the
 * background (and Android 14 restricts location-typed starts), so the attempt is
 * wrapped: if it is refused, the flush still runs and the tracking window
 * resumes when the driver next opens the app (the trips screen re-starts it).
 */
class TrackingBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val activeTripId = TrackingStateStore.activeTripId(context)
        if (activeTripId != null && TrackingPermissions.canTrack(context)) {
            runCatching { TrackingScheduler.start(context, activeTripId) }
                .onFailure { TrackingScheduler.enqueueFlush(context) }
        } else {
            TrackingScheduler.enqueueFlush(context)
        }
    }
}
