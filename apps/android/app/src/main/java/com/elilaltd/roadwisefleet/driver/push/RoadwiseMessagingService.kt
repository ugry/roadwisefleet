package com.elilaltd.roadwisefleet.driver.push

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Receives FCM registration updates and data pushes (board #103, AND1-A1).
 * The token is a device credential, so only the event is logged — never the
 * token itself. A2 (#104) persists the refreshed token against the device
 * credential; A3 (#105) turns a tracking push into a sync nudge.
 */
class RoadwiseMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        Log.i(TAG, "FCM registration token refreshed")
    }

    override fun onMessageReceived(message: RemoteMessage) {
        Log.i(TAG, "push received: ${message.data["type"] ?: "unknown"}")
    }

    private companion object {
        const val TAG = "RoadwisePush"
    }
}
