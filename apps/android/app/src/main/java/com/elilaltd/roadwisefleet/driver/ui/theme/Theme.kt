package com.elilaltd.roadwisefleet.driver.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** RoadwiseFleet palette: fleet blue, alert amber, SOS red. */
private val FleetBlue = Color(0xFF1B5E9C)
private val FleetBlueLight = Color(0xFF7FB4E0)
private val FleetAmber = Color(0xFFE8952C)
private val SosRed = Color(0xFFC62828)

@Composable
fun RoadwiseFleetTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colorScheme = if (darkTheme) {
        darkColorScheme(primary = FleetBlueLight, secondary = FleetAmber, error = SosRed)
    } else {
        lightColorScheme(primary = FleetBlue, secondary = FleetAmber, error = SosRed)
    }
    MaterialTheme(colorScheme = colorScheme, content = content)
}
