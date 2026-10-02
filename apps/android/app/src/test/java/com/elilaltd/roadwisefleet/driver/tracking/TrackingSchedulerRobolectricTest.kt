package com.elilaltd.roadwisefleet.driver.tracking

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import com.elilaltd.roadwisefleet.core.model.TrackingCore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * AND1-QA1 (#108) criterion 3 — the tracking window and the ~10-minute cadence.
 * UNRUN pending CI job #113.
 *
 * The pure cadence rule (`TrackingCore.isSampleDue`, `phaseFor`) is already
 * pinned in `core/src/test/.../TrackingCoreTest.kt`. This file adds the *window
 * and scheduling* behaviour that only makes sense with a Context:
 *   - the owner-confirmed 10-minute sample interval and the 15-minute WorkManager
 *     flush floor (the platform floor) are the shipped constants;
 *   - Start Trip opens the window (state store) and registers the periodic flush;
 *   - the one-shot flush is network-constrained and unique (KEEP);
 *   - stop clears the window and cancels both jobs, so no always-on service runs.
 *
 * Robolectric is the right host: `WorkManagerTestInitHelper` gives deterministic
 * scheduling without a device. Needs (see qa/and1-android-tests/README.md):
 *   testImplementation("org.robolectric:robolectric:4.13")
 *   testImplementation("androidx.test:core:1.6.1")
 *   testImplementation("androidx.work:work-testing:2.9.1")
 *   testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
 * and in `android { testOptions { unitTests.isIncludeAndroidResources = true } }`.
 */
@RunWith(RobolectricTestRunner::class)
class TrackingSchedulerRobolectricTest {

    private lateinit var context: Context
    private lateinit var workManager: WorkManager

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        val config = Configuration.Builder()
            .setMinimumLoggingLevel(android.util.Log.DEBUG)
            .setExecutor(SynchronousExecutor())
            .build()
        WorkManagerTestInitHelper.initializeTestWorkManager(context, config)
        workManager = WorkManager.getInstance(context)
        TrackingStateStore.clear(context)
        workManager.cancelAllWork().result
    }

    @Test
    fun `the shipped cadence is ten minutes and the flush floor is fifteen`() {
        // Owner decision 2026-10-01: ~10-minute background cadence while tracking.
        assertEquals(10L * 60L * 1000L, TrackingCore.SAMPLE_INTERVAL_MS)
        // WorkManager's periodic floor is 15 minutes; the service owns the 10-minute cadence.
        assertEquals(15L, TrackingCore.FLUSH_INTERVAL_MINUTES)
    }

    @Test
    fun `start opens the tracking window and registers the periodic flush`() {
        TrackingScheduler.start(context, "trip-qa-1")

        assertEquals("trip-qa-1", TrackingStateStore.activeTripId(context))

        val periodic = workManager.getWorkInfosForUniqueWork("roadwisefleet.gps.flush").get()
        assertEquals("exactly one unique periodic flush", 1, periodic.size)
        assertTrue(
            "the periodic flush is enqueued",
            periodic[0].state == WorkInfo.State.ENQUEUED,
        )
        // The flush must require connectivity so it cannot spin while offline.
        assertTrue(
            "the flush requires a connected network",
            periodic[0].constraints.requiredNetworkType == androidx.work.NetworkType.CONNECTED,
        )
    }

    @Test
    fun `a sampled point enqueues a unique one-shot flush`() {
        TrackingScheduler.enqueueFlush(context)
        TrackingScheduler.enqueueFlush(context) // KEEP -> still one unique job

        val oneShot = workManager.getWorkInfosForUniqueWork("roadwisefleet.gps.flush.now").get()
        assertEquals("KEEP keeps exactly one one-shot flush", 1, oneShot.size)
        assertTrue(oneShot[0].state == WorkInfo.State.ENQUEUED)
        assertTrue(
            "the one-shot flush waits for connectivity",
            oneShot[0].constraints.requiredNetworkType == androidx.work.NetworkType.CONNECTED,
        )
    }

    @Test
    fun `stop closes the window and cancels both flush jobs`() {
        TrackingScheduler.start(context, "trip-qa-2")
        TrackingScheduler.enqueueFlush(context)

        TrackingScheduler.stop(context)

        assertNull("the active trip is cleared", TrackingStateStore.activeTripId(context))
        val periodic = workManager.getWorkInfosForUniqueWork("roadwisefleet.gps.flush").get()
        val oneShot = workManager.getWorkInfosForUniqueWork("roadwisefleet.gps.flush.now").get()
        assertTrue(
            "cancelled periodic work is CANCELLED (or gone)",
            periodic.isEmpty() || periodic.all { it.state == WorkInfo.State.CANCELLED },
        )
        assertTrue(
            "cancelled one-shot work is CANCELLED (or gone)",
            oneShot.isEmpty() || oneShot.all { it.state == WorkInfo.State.CANCELLED },
        )
    }

    @Test
    fun `no sampling window is opened before Start Trip`() {
        // The store starts empty: phaseFor(ASSIGNED, tracking=false) is NOT_STARTED,
        // so the shell never starts the service before the driver taps Start Trip.
        assertNull(TrackingStateStore.activeTripId(context))
        assertEquals(
            com.elilaltd.roadwisefleet.core.model.TrackingPhase.NOT_STARTED,
            TrackingCore.phaseFor(tracking = false, status = "ASSIGNED"),
        )
    }
}
