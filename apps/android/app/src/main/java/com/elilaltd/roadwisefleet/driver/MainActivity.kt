package com.elilaltd.roadwisefleet.driver

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
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
