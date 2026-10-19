package com.elilaltd.roadwisefleet.driver.di

import android.content.Context
import androidx.compose.runtime.staticCompositionLocalOf
import android.os.Build
import com.elilaltd.roadwisefleet.core.auth.AuthController
import com.elilaltd.roadwisefleet.core.auth.AuthRules
import com.elilaltd.roadwisefleet.core.auth.DeviceAuth
import com.elilaltd.roadwisefleet.core.auth.DeviceKeyMaterial
import com.elilaltd.roadwisefleet.core.data.local.RoadwiseDatabase
import com.elilaltd.roadwisefleet.core.data.remote.ApiClient
import com.elilaltd.roadwisefleet.core.data.repo.TripRepository
import com.elilaltd.roadwisefleet.core.data.repo.TrackingRepository
import com.elilaltd.roadwisefleet.core.data.sync.ConnectivityObserver
import com.elilaltd.roadwisefleet.core.data.sync.SyncEngine
import com.elilaltd.roadwisefleet.core.i18n.LocaleController
import com.elilaltd.roadwisefleet.driver.BuildConfig
import com.elilaltd.roadwisefleet.driver.auth.KeystoreDeviceKeyMaterial
import com.elilaltd.roadwisefleet.driver.push.PushRegistrar
import com.elilaltd.roadwisefleet.driver.session.SessionStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import java.util.Locale

/**
 * Manual dependency container (board #103, AND1-A1). Deliberately not Hilt: the
 * A1 object graph is four singletons, and a compile-time DI framework is a
 * decision for when A2/A3 add feature modules — recorded in the ADR.
 */
class AppContainer(context: Context) {
    private val appContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    val session = SessionStore(appContext)
    val localeController = LocaleController(
        context = appContext,
        assetDir = BuildConfig.LOCALE_ASSET_DIR,
        stored = session.locale,
        device = Locale.getDefault().language,
    )
    val database = RoadwiseDatabase.get(appContext)
    val api = ApiClient(BuildConfig.API_BASE_URL) { session.token }
    // Passwordless device auth (board #104, AND1-A2): the Keystore-backed
    // keypair and the challenge -> sign -> verify orchestration.
    val deviceKeys: DeviceKeyMaterial = KeystoreDeviceKeyMaterial()
    val deviceAuth = DeviceAuth(api, deviceKeys)
    // Board #104 reopen: the login gate. `start()` decides between the login
    // screen, a passwordless re-login and the shell; it is owned here so the
    // state survives an Activity recreation.
    val auth = AuthController(api, deviceAuth, session) {
        AuthRules.deviceLabel(Build.MANUFACTURER, Build.MODEL)
    }
    val connectivity = ConnectivityObserver(appContext)
    val repository = TripRepository(api, database.tripDao(), database.outboxDao())
    // Board #106 (AND1-A4): the offline GPS queue, drained by GpsFlushWorker.
    val trackingRepository = TrackingRepository(api, database.gpsPointDao())
    val syncEngine = SyncEngine(api, database.outboxDao(), connectivity, scope)
    val push = PushRegistrar(appContext)
}

/** Provided by [com.elilaltd.roadwisefleet.driver.MainActivity]. */
val LocalAppContainer = staticCompositionLocalOf<AppContainer> {
    error("AppContainer is not provided")
}
