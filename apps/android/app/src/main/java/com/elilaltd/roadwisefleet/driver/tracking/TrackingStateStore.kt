package com.elilaltd.roadwisefleet.driver.tracking

import android.content.Context
import android.content.SharedPreferences

/**
 * Remembers which trip the tracking service is following (board #106, AND1-A4),
 * so a reboot can resume. Only an id is stored — never a location, never a token.
 */
object TrackingStateStore {
    private const val PREFS = "roadwisefleet.driver.tracking"
    private const val KEY_ACTIVE_TRIP = "activeTripId"

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun activeTripId(context: Context): String? =
        prefs(context).getString(KEY_ACTIVE_TRIP, null)

    fun setActive(context: Context, tripId: String) {
        prefs(context).edit().putString(KEY_ACTIVE_TRIP, tripId).apply()
    }

    fun clear(context: Context) {
        prefs(context).edit().remove(KEY_ACTIVE_TRIP).apply()
    }
}
