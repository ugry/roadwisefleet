package com.elilaltd.roadwisefleet.driver.ui.trips

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.elilaltd.roadwisefleet.core.data.local.TripEntity
import com.elilaltd.roadwisefleet.driver.di.AppContainer
import com.elilaltd.roadwisefleet.driver.di.LocalAppContainer
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * AND1-QA1 (#108) — the Start-Trip UI gate. UNRUN pending CI job #113.
 *
 * Two client-side rules the Android acceptance depends on:
 *   1. the Start Trip action appears only for an ASSIGNED trip (it is the
 *      primary action of the phase chain) — a DELIVERED trip offers no Start;
 *   2. tapping Start Trip with location permission denied must NOT queue the
 *      Start action until the permission grant comes back (the shell requests
 *      ACCESS_FINE_LOCATION first, then enqueues START + opens the window).
 *
 * State is seeded directly into the app's Room store so the assertion does not
 * depend on a live backend. Needs (see qa/and1-android-tests/README.md):
 *   androidTestImplementation("androidx.test.ext:junit:1.2.1")
 *   androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
 *   androidTestImplementation("androidx.compose.ui:ui-test-junit4:<bom>")
 *   androidTestImplementation("androidx.compose.ui:ui-test-manifest:<bom>")
 *   debugImplementation("androidx.compose.ui:ui-test-manifest:<bom>")
 */
@RunWith(AndroidJUnit4::class)
class StartTripUiGateTest {

    @get:Rule
    val composeRule = createComposeRule()

    private lateinit var container: AppContainer
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    private fun tripEntity(id: String, status: String) = TripEntity(
        id = id,
        status = status,
        origin = "QA origin",
        destination = "QA destination",
        cargo = "QA cargo",
        customer = "QA customer",
        truckPlate = "QA-01",
        rateEur = null,
        updatedAtEpochMs = 1_000L,
        documentsJson = "[]",
        tracking = false,
    )

    @Before
    fun setUp() {
        container = AppContainer(context)
        runBlocking { container.database.tripDao().clear() }
    }

    private fun render() {
        composeRule.setContent {
            CompositionLocalProvider(LocalAppContainer provides container) {
                TripsScreen(container.localeController.translator())
            }
        }
    }

    /**
     * Board #134 — the trips list is a Room flow with `initial = emptyList()`, so
     * the seeded card is composed in a later frame than the first composition.
     * [androidx.compose.ui.test.junit4.ComposeTestRule.waitForIdle] only drains the
     * main looper and returns before that emission, so wait for the card itself.
     */
    private fun waitForText(text: String, timeoutMs: Long = WAIT_TIMEOUT_MS) {
        composeRule.waitUntil(timeoutMs) {
            composeRule.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()
        }
    }

    @Test
    // Human label: an ASSIGNED trip shows Start trip and holds it until location is granted.
    // Underscored: D8 rejects space-containing names for the minSdk 24 DEX level.
    fun an_ASSIGNED_trip_shows_Start_trip_and_holds_it_until_location_is_granted() {
        runBlocking { container.database.tripDao().upsertAll(listOf(tripEntity("trip-assigned", "ASSIGNED"))) }
        render()

        // Board #134: wait for the seeded card, not for the looper to drain.
        waitForText(TRIP_ROUTE_LABEL)
        val label = container.localeController.translator().t("driver.action.EN_ROUTE")
        composeRule.onNodeWithText(label).assertIsDisplayed()

        // No location permission is granted in a fresh instrumented run, so the
        // tap must open the permission request instead of queueing the action.
        composeRule.onNodeWithText(label).performClick()
        composeRule.waitForIdle()

        val queued = runBlocking { container.database.outboxDao().count() }
        assertEquals("Start must not be queued before location permission is granted", 0, queued)
    }

    @Test
    // Human label: a DELIVERED trip offers no Start trip action.
    fun a_DELIVERED_trip_offers_no_Start_trip_action() {
        runBlocking { container.database.tripDao().upsertAll(listOf(tripEntity("trip-delivered", "DELIVERED"))) }
        render()

        // Board #134: wait for the card so the absence check is not made against
        // the flow's empty initial value.
        waitForText(TRIP_ROUTE_LABEL)
        val label = container.localeController.translator().t("driver.action.EN_ROUTE")
        composeRule.onNodeWithText(label).assertDoesNotExist()
    }

    private companion object {
        /** `Trip.routeLabel` of the seeded fixture (`origin → destination`). */
        const val TRIP_ROUTE_LABEL = "QA origin → QA destination"

        /** Generous but finite: the AVD is headless and slow to draw a frame. */
        const val WAIT_TIMEOUT_MS = 5_000L
    }
}
