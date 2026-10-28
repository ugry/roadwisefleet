package com.elilaltd.roadwisefleet.driver

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import com.elilaltd.roadwisefleet.core.auth.AuthState
import com.elilaltd.roadwisefleet.driver.di.LocalAppContainer
import com.elilaltd.roadwisefleet.driver.ui.DriverShell
import com.elilaltd.roadwisefleet.driver.ui.auth.EmailCodeScreen
import com.elilaltd.roadwisefleet.driver.ui.auth.LoginScreen
import com.elilaltd.roadwisefleet.driver.ui.auth.RestoringScreen
import com.elilaltd.roadwisefleet.driver.ui.theme.RoadwiseFleetTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Board #122: Android 16 (targetSdk 36) enforces edge-to-edge and removes
        // the opt-out. Call it explicitly so the behaviour is identical on the
        // older versions the drivers still run; the Material3 Scaffold/TopAppBar/
        // NavigationBar in DriverShell consume the system-bar insets.
        enableEdgeToEdge()
        val container = (application as RoadwiseApp).container
        setContent {
            CompositionLocalProvider(LocalAppContainer provides container) {
                val locale by container.localeController.locale.collectAsState()
                val translator = remember(locale) { container.localeController.translator() }
                val authState by container.auth.state.collectAsState()
                val codeAvailable by container.auth.codeAvailable.collectAsState()
                // Board #104 reopen: the auth gate. `start()` restores the stored
                // session, or silently re-authenticates with the device
                // credential; the shell is never composed before that resolves.
                LaunchedEffect(Unit) { container.auth.start() }
                // One probe per login screen: hide passwordless email sign-in
                // when the server has no sender configured (#124).
                LaunchedEffect(authState is AuthState.SignedOut) {
                    if (authState is AuthState.SignedOut) container.auth.probeCodeAvailability()
                }
                RoadwiseFleetTheme {
                    when (val state = authState) {
                        AuthState.Restoring -> RestoringScreen(translator = translator)

                        is AuthState.SignedOut -> LoginScreen(
                            translator = translator,
                            versionName = BuildConfig.VERSION_NAME,
                            noticeKey = state.noticeKey,
                            onSignIn = { email, password -> container.auth.signIn(email, password) },
                            emailCodeEnabled = codeAvailable,
                            onRequestCode = { email -> container.auth.requestCode(email) },
                            // Board #125: WhatsApp stays hidden until the build
                            // flag is on AND #124 has the provider ready.
                            whatsappEnabled = BuildConfig.WHATSAPP_OTP_ENABLED,
                            onWhatsApp = { /* provider (#124) not wired yet */ },
                        )

                        is AuthState.CodeEntry -> EmailCodeScreen(
                            translator = translator,
                            email = state.email,
                            noticeKey = state.noticeKey,
                            onVerify = { code -> container.auth.verifyCode(state.email, code) },
                            onResend = { container.auth.requestCode(state.email) },
                            onBack = { container.auth.cancelCode() },
                        )

                        is AuthState.SignedIn -> DriverShell(
                            translator = translator,
                            user = state.user,
                            versionName = BuildConfig.VERSION_NAME,
                            noticeKey = state.noticeKey,
                            onSignOut = { container.auth.signOut() },
                            onDeleteAccount = { container.auth.deleteAccount() },
                        )
                    }
                }
            }
        }
    }
}
