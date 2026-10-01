package com.elilaltd.roadwisefleet.driver.tracking

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.elilaltd.roadwisefleet.core.model.SampleResult
import com.elilaltd.roadwisefleet.core.model.TrackingCore
import com.elilaltd.roadwisefleet.driver.R
import com.elilaltd.roadwisefleet.driver.RoadwiseApp
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Foreground location service (board #106, AND1-A4).
 *
 * It exists only for the active-trip window: [TrackingScheduler.start] starts it
 * on Start Trip and [TrackingScheduler.stop] stops it when the trip is delivered
 * or tracking is turned off. It requests FusedLocation updates at the
 * owner-confirmed 10-minute interval with `PRIORITY_BALANCED_POWER_ACCURACY`
 * (no continuous GPS, no wake-locks), stores each fix in Room through
 * [com.elilaltd.roadwisefleet.core.data.repo.TrackingRepository] and asks
 * WorkManager to flush.
 *
 * The Android platform floor for WorkManager periodic work is 15 minutes, which
 * is why the 10-minute cadence lives here and WorkManager only flushes/retries.
 * Battery cost is recorded in `docs/android-architecture.md` §10.
 */
class LocationTrackingService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var fusedClient: FusedLocationProviderClient? = null
    private var tripId: String? = null

    private val container by lazy { (application as RoadwiseApp).container }

    private val locationCallback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            val id = tripId ?: return
            val location = result.lastLocation ?: return
            val now = System.currentTimeMillis()
            val at = if (location.time > 0L) location.time else now
            val accuracy = if (location.hasAccuracy()) location.accuracy.toInt() else null
            val validated = TrackingCore.normalizeSample(
                tripId = id,
                clientId = TrackingCore.newClientId(),
                lat = location.latitude,
                lng = location.longitude,
                atEpochMs = at,
                accuracyM = accuracy,
                nowEpochMs = now,
            )
            if (validated !is SampleResult.Ok) return
            scope.launch {
                container.trackingRepository.record(validated.sample)
                TrackingScheduler.enqueueFlush(applicationContext)
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val id = intent?.getStringExtra(TrackingScheduler.EXTRA_TRIP_ID)
        if (id.isNullOrBlank()) {
            stopSelf()
            return START_NOT_STICKY
        }
        tripId = id
        TrackingStateStore.setActive(this, id)
        startForegroundTracking()
        requestUpdates()
        TrackingScheduler.enqueueFlush(this)
        // Restart if the process is killed mid-trip; only the active window runs.
        return START_STICKY
    }

    private fun startForegroundTracking() {
        val notification = buildNotification()
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        } else {
            0
        }
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
    }

    private fun requestUpdates() {
        val client = LocationServices.getFusedLocationProviderClient(this)
        fusedClient = client
        val request = LocationRequest.Builder(
            Priority.PRIORITY_BALANCED_POWER_ACCURACY,
            TrackingCore.SAMPLE_INTERVAL_MS,
        )
            .setMinUpdateIntervalMillis(TrackingCore.SAMPLE_INTERVAL_MS)
            .build()
        try {
            client.requestLocationUpdates(request, locationCallback, Looper.getMainLooper())
        } catch (_: SecurityException) {
            // The driver revoked location: stop rather than run a useless service.
            stopSelf()
        }
    }

    override fun onDestroy() {
        fusedClient?.removeLocationUpdates(locationCallback)
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.tracking_notification_channel),
            NotificationManager.IMPORTANCE_LOW,
        )
        channel.description = getString(R.string.tracking_notification_text)
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle(getString(R.string.tracking_notification_title))
            .setContentText(getString(R.string.tracking_notification_text))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

    private companion object {
        const val CHANNEL_ID = "roadwisefleet.tracking"
        const val NOTIFICATION_ID = 4106
    }
}
