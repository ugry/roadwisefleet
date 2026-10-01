package com.elilaltd.roadwisefleet.driver.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.elilaltd.roadwisefleet.core.i18n.Catalog
import com.elilaltd.roadwisefleet.core.i18n.Translator
import com.elilaltd.roadwisefleet.core.model.TripStatus
import com.elilaltd.roadwisefleet.driver.di.LocalAppContainer
import com.elilaltd.roadwisefleet.driver.ui.trips.TripsScreen
import kotlinx.coroutines.launch

/**
 * The one-thumb shell (board #103, AND1-A1): five tabs and an always-visible
 * SOS button, per `docs/ux-flows/03-driver-flow.mmd`.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DriverShell(translator: Translator) {
    val container = LocalAppContainer.current
    val navController = rememberNavController()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }
    var showSos by remember { mutableStateOf(false) }

    val trips by remember { container.repository.observeTrips() }.collectAsState(initial = emptyList())
    val currentTrip = trips.firstOrNull { !TripStatus.isTerminal(it.status) } ?: trips.firstOrNull()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(translator.t("brand.name")) },
                actions = {
                    LocaleMenu(translator) { picked -> container.localeController.set(picked) }
                },
            )
        },
        bottomBar = { DriverBottomBar(navController, translator) },
        snackbarHost = { SnackbarHost(snackbarHostState) },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { showSos = true },
                containerColor = MaterialTheme.colorScheme.error,
                contentColor = MaterialTheme.colorScheme.onError,
                icon = { Icon(Icons.Filled.Warning, contentDescription = null) },
                text = { Text(translator.t("driver.sos")) },
            )
        },
    ) { padding ->
        NavHost(
            navController = navController,
            startDestination = DriverDestination.Trips.route,
            modifier = Modifier.padding(padding),
        ) {
            composable(DriverDestination.Trips.route) { TripsScreen(translator) }
            composable(DriverDestination.Documents.route) {
                PlaceholderScreen(
                    title = translator.t("nav.documents"),
                    body = translator.t("driver.shell.documents.body"),
                    extra = translator.t("driver.requiredDocuments"),
                )
            }
            composable(DriverDestination.Money.route) {
                PlaceholderScreen(
                    title = translator.t("nav.money"),
                    body = translator.t("driver.shell.money.body"),
                )
            }
            composable(DriverDestination.Messages.route) {
                PlaceholderScreen(
                    title = translator.t("nav.messages"),
                    body = translator.t("driver.shell.messages.body"),
                )
            }
            composable(DriverDestination.More.route) {
                PlaceholderScreen(
                    title = translator.t("nav.more"),
                    body = translator.t("driver.shell.more.body"),
                )
            }
        }
    }

    if (showSos) {
        SosDialog(
            translator = translator,
            onDismiss = { showSos = false },
            onCall = {
                val intent = Intent(Intent.ACTION_DIAL, Uri.parse("tel:112"))
                runCatching { context.startActivity(intent) }
                showSos = false
            },
            onReport = {
                val tripId = currentTrip?.id
                showSos = false
                scope.launch {
                    if (tripId != null) {
                        container.repository.enqueueSos(tripId, "driver_sos")
                        container.syncEngine.syncNow()
                    }
                    snackbarHostState.showSnackbar(translator.t("driver.sos.reported"))
                }
            },
        )
    }
}

@Composable
private fun PlaceholderScreen(title: String, body: String, extra: String? = null) {
    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(title, style = MaterialTheme.typography.headlineSmall)
        Text(body)
        extra?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable
private fun DriverBottomBar(navController: NavHostController, translator: Translator) {
    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination?.route
    NavigationBar {
        DriverDestination.entries.forEach { destination ->
            NavigationBarItem(
                selected = currentRoute == destination.route,
                onClick = {
                    navController.navigate(destination.route) {
                        popUpTo(navController.graph.startDestinationId) { saveState = true }
                        launchSingleTop = true
                        restoreState = true
                    }
                },
                icon = { Icon(destination.icon, contentDescription = null) },
                label = { Text(translator.t(destination.labelKey)) },
            )
        }
    }
}

@Composable
private fun LocaleMenu(translator: Translator, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    IconButton(onClick = { open = true }) {
        Icon(Icons.Filled.Language, contentDescription = translator.t("common.language"))
    }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
        Catalog.SUPPORTED.forEach { code ->
            DropdownMenuItem(
                text = { Text(Catalog.LABELS[code] ?: code) },
                onClick = {
                    onPick(code)
                    open = false
                },
            )
        }
    }
}

@Composable
private fun SosDialog(
    translator: Translator,
    onDismiss: () -> Unit,
    onCall: () -> Unit,
    onReport: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        icon = {
            Icon(
                Icons.Filled.Warning,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.error,
            )
        },
        title = { Text(translator.t("driver.sos.title")) },
        text = { Text(translator.t("driver.sos.body")) },
        confirmButton = {
            TextButton(onClick = onCall) { Text(translator.t("driver.sos.call")) }
        },
        dismissButton = {
            TextButton(onClick = onReport) { Text(translator.t("driver.sos.report")) }
        },
    )
}
