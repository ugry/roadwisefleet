package com.elilaltd.roadwisefleet.driver.ui.trips

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.elilaltd.roadwisefleet.core.i18n.Translator
import com.elilaltd.roadwisefleet.core.model.SyncState
import com.elilaltd.roadwisefleet.core.model.Trip
import com.elilaltd.roadwisefleet.core.model.TripCore
import com.elilaltd.roadwisefleet.core.model.TripStatus
import com.elilaltd.roadwisefleet.driver.di.AppContainer
import com.elilaltd.roadwisefleet.driver.di.LocalAppContainer
import kotlinx.coroutines.launch

/**
 * Trips — the home tab (board #103, AND1-A1): the current assignment, the next
 * legal status as big one-thumb buttons, the required-document gate and the
 * offline / sync state. The API remains authoritative; this renders from the
 * local store and queues writes.
 */
@Composable
fun TripsScreen(translator: Translator) {
    val container = LocalAppContainer.current
    val scope = rememberCoroutineScope()

    val trips by remember { container.repository.observeTrips() }.collectAsState(initial = emptyList())
    val outbox by remember { container.repository.observeOutbox() }.collectAsState(initial = emptyList())
    val online by remember { container.connectivity.observe() }.collectAsState(initial = container.connectivity.isOnline()) }
    val syncState by container.syncEngine.state.collectAsState()

    var pendingConfirm by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) { container.repository.refresh() }

    val current = trips.firstOrNull { !TripStatus.isTerminal(it.status) } ?: trips.firstOrNull()

    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        SyncChip(
            translator = translator,
            state = syncState,
            online = online,
            pending = outbox.size,
            onSync = { scope.launch { container.syncEngine.syncNow() } },
        )

        if (current == null) {
            Text(translator.t("driver.noTrips"))
        } else {
            TripCard(current, translator)
            Text(translator.t("driver.updateStatus"), style = MaterialTheme.typography.titleMedium)
            TripStatus.nextLegalStatuses(current.status).forEach { target ->
                Button(
                    onClick = {
                        if (TripStatus.requiresConfirmation(target)) {
                            pendingConfirm = target
                        } else {
                            scope.launch { enqueueAndSync(container, current.id, target) }
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(translator.t("driver.action.$target"))
                }
            }
            if (TripStatus.isTerminal(current.status)) {
                Text(translator.t("driver.closed"), style = MaterialTheme.typography.bodyMedium)
            }
            if (current.status == "DELIVERED" && !TripCore.podSatisfied(current.documents)) {
                Text(translator.t("driver.podGate"), style = MaterialTheme.typography.bodyMedium)
            }
        }
    }

    val confirmTarget = pendingConfirm
    if (confirmTarget != null) {
        AlertDialog(
            onDismissRequest = { pendingConfirm = null },
            title = { Text(translator.t("driver.action.$confirmTarget")) },
            text = {
                Text(
                    translator.t(
                        "driver.confirmStatus",
                        mapOf("status" to translator.t("status.$confirmTarget")),
                    ),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        pendingConfirm = null
                        val tripId = current?.id
                        if (tripId != null) {
                            scope.launch { enqueueAndSync(container, tripId, confirmTarget) }
                        }
                    },
                ) { Text(translator.t("common.confirm")) }
            },
            dismissButton = {
                TextButton(onClick = { pendingConfirm = null }) {
                    Text(translator.t("common.close"))
                }
            },
        )
    }
}

private suspend fun enqueueAndSync(container: AppContainer, tripId: String, target: String) {
    container.repository.enqueueStatus(tripId, target)
    container.syncEngine.syncNow()
}

@Composable
private fun TripCard(trip: Trip, translator: Translator) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(trip.routeLabel, style = MaterialTheme.typography.titleLarge)
            Text("${translator.t("common.status")}: ${translator.t("status.${trip.status}")}")
            trip.cargo?.let { Text("${translator.t("driver.cargo")}: $it") }
            trip.truckPlate?.let { Text("${translator.t("driver.truck")}: $it") }
            Text(translator.t("driver.etaUnavailable"), style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun SyncChip(
    translator: Translator,
    state: SyncState,
    online: Boolean,
    pending: Int,
    onSync: () -> Unit,
) {
    val indicator = TripCore.syncIndicator(
        pending = pending,
        online = online,
        syncing = state == SyncState.SYNCING,
        lastError = if (state == SyncState.ERROR) "error" else null,
    )
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = if (pending > 0) {
                translator.plural(indicator.labelKey, pending)
            } else {
                translator.t(indicator.labelKey)
            },
            style = MaterialTheme.typography.bodyMedium,
        )
        if (online && pending > 0) {
            TextButton(onClick = onSync) { Text(translator.t("driver.syncNow")) }
        }
    }
}
