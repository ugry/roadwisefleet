package com.elilaltd.roadwisefleet.driver

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import com.elilaltd.roadwisefleet.driver.di.LocalAppContainer
import com.elilaltd.roadwisefleet.driver.ui.DriverShell
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
                RoadwiseFleetTheme {
                    DriverShell(translator = translator)
                }
            }
        }
    }
}
