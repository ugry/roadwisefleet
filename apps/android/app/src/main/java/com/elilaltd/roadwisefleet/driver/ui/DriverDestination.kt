package com.elilaltd.roadwisefleet.driver.ui

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Euro
import androidx.compose.material.icons.filled.LocalShipping
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.ui.graphics.vector.ImageVector

/**
 * The five bottom-navigation destinations (board #103, AND1-A1), matching the
 * pilot driver flow `docs/ux-flows/03-driver-flow.mmd`: Trips (home),
 * Documents, Money, Messages, More — with SOS always on screen separately.
 */
enum class DriverDestination(
    val route: String,
    val labelKey: String,
    val icon: ImageVector,
) {
    Trips("trips", "nav.trips", Icons.Filled.LocalShipping),
    Documents("documents", "nav.documents", Icons.Filled.Description),
    Money("money", "nav.money", Icons.Filled.Euro),
    Messages("messages", "nav.messages", Icons.Filled.Email),
    More("more", "nav.more", Icons.Filled.MoreHoriz),
}
