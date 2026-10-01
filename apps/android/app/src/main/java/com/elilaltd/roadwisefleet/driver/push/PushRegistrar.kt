package com.elilaltd.roadwisefleet.driver.push

import android.content.Context
import android.util.Log
import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * FCM registration wiring (board #103, AND1-A1).
 *
 * The Firebase client config (`google-services.json`) is optional in this repo:
 * when it is absent, the Google Services plugin is not applied and
 * [currentToken] returns null, so the scaffold still builds and runs. When the
 * operator drops the config in, the same call returns the FCM registration
 * token for A2 (#104) to register with the backend. The token is a device
 * credential: it is never logged and never written to the repository.
 */
class PushRegistrar(private val context: Context) {
    suspend fun currentToken(): String? = withContext(Dispatchers.IO) {
        if (FirebaseApp.getApps(context).isEmpty()) return@withContext null
        try {
            val app = FirebaseApp.getInstance()
            Tasks.await(FirebaseMessaging.getInstance(app).token)
        } catch (t: Throwable) {
            Log.w(TAG, "FCM token unavailable: ${t.javaClass.simpleName}")
            null
        }
    }

    private companion object {
        const val TAG = "RoadwisePush"
    }
}
