package com.elilaltd.roadwisefleet.driver.tracking

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat

/**
 * The permissions background tracking needs (board #106, AND1-A4):
 * `ACCESS_FINE_LOCATION` for the fix, `ACCESS_BACKGROUND_LOCATION` for the
 * moments the app is backgrounded during an active trip, and
 * `POST_NOTIFICATIONS` for the required foreground-service notification (API 33+).
 *
 * `ACCESS_BACKGROUND_LOCATION` is requested but treated as best-effort: from
 * API 30 the system only grants it from a settings page, so the service starts
 * as long as fine location is held (tracking then degrades to in-use only). The
 * ADR records that limitation and the Play Data-Safety justification it needs.
 */
object TrackingPermissions {
    fun required(): Array<String> {
        val permissions = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            permissions.add(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        return permissions.toTypedArray()
    }

    /** The minimum that lets sampling start: a fine fix. */
    fun canTrack(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    /** True when the whole set is granted (background + notifications included). */
    fun allGranted(context: Context): Boolean = required().all {
        ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
    }
}
