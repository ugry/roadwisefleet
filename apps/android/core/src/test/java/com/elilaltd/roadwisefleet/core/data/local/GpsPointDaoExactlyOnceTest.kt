package com.elilaltd.roadwisefleet.core.data.local

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * AND1-QA1 (#108) criterion 4 — the Room offline queue replays exactly once.
 * UNRUN pending CI job #113.
 *
 * The GPS queue is exactly-once because the device-generated `clientId` is the
 * primary key and the DAO inserts with `OnConflictStrategy.IGNORE`: recording the
 * same sample twice (a duplicate fix, a replayed capture) is a no-op, so the
 * eventual upload cannot double-insert server-side either. This file pins that
 * queue property against a real in-memory Room database (Robolectric JVM).
 *
 * The wire-level exactly-once proof (the server dedupes on the same clientId) is
 * already covered by `apps/api/test/gps-ingest.test.ts`; the Tier-1 suite covers
 * the endpoint contract.
 *
 * Needs (see qa/and1-android-tests/README.md):
 *   testImplementation("org.robolectric:robolectric:4.13")
 *   testImplementation("androidx.test:core:1.6.1")
 *   testImplementation("androidx.room:room-testing:2.6.1")
 *   testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
 * and `android { testOptions { unitTests.isIncludeAndroidResources = true } }`.
 */
@RunWith(RobolectricTestRunner::class)
class GpsPointDaoExactlyOnceTest {

    private lateinit var db: RoadwiseDatabase
    private lateinit var dao: GpsPointDao

    private fun point(clientId: String, tripId: String = "trip-1", at: Long = 1_000L, uploaded: Boolean = false) =
        GpsPointEntity(
            clientId = clientId,
            tripId = tripId,
            atEpochMs = at,
            lat = 52.5,
            lng = 13.4,
            accuracyM = 12,
            uploaded = uploaded,
        )

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext<Context>(),
            RoadwiseDatabase::class.java,
        ).allowMainThreadQueries().build()
        dao = db.gpsPointDao()
    }

    @After
    fun tearDown() = db.close()

    @Test
    fun `recording the same client id twice is a no-op (exactly-once)`() = runTest {
        dao.insert(point("client-1"))
        dao.insert(point("client-1")) // duplicate replay / duplicate fix

        assertEquals("the queue holds exactly one row", 1, dao.pendingCount())
        assertEquals("the unsent list has one row", 1, dao.unsent().size)
    }

    @Test
    fun `sampling the same trip twice at different instants queues both points`() = runTest {
        dao.insert(point("client-1", at = 1_000L))
        dao.insert(point("client-2", at = 601_000L)) // 10 minutes later

        assertEquals(2, dao.pendingCount())
    }

    @Test
    fun `a successful upload is marked and purged, leaving the queue empty`() = runTest {
        dao.insert(point("client-1"))
        dao.insert(point("client-2"))

        dao.markUploaded(listOf("client-1", "client-2"))
        dao.purgeUploaded()

        assertEquals("nothing is pending after a clean flush", 0, dao.pendingCount())
        assertEquals(0, dao.unsent().size)
    }

    @Test
    fun `only the accepted batch is purged; an unsent point survives a partial flush`() = runTest {
        dao.insert(point("client-1", at = 1_000L))
        dao.insert(point("client-2", at = 2_000L))

        dao.markUploaded(listOf("client-1")) // the server accepted only the first batch
        dao.purgeUploaded()

        assertEquals("the unaccepted point is still queued", 1, dao.pendingCount())
        assertEquals("client-2", dao.unsent().single().clientId)
    }

    @Test
    fun `unsent points are read oldest-first, regardless of insert order`() = runTest {
        dao.insert(point("client-late", at = 900_000L))
        dao.insert(point("client-early", at = 100_000L))
        dao.insert(point("client-mid", at = 500_000L))

        assertEquals(
            listOf("client-early", "client-mid", "client-late"),
            dao.unsent().map { it.clientId },
        )
    }

    @Test
    fun `lastSampleAt returns the newest instant for the trip, null when empty`() = runTest {
        assertEquals(null, dao.lastSampleAt("trip-1"))
        dao.insert(point("client-1", at = 1_000L))
        dao.insert(point("client-2", at = 3_000L))
        assertEquals(3_000L, dao.lastSampleAt("trip-1"))
        assertEquals("another trip has no samples", null, dao.lastSampleAt("trip-2"))
    }

    @Test
    fun `the database round-trips a point through the offline store`() = runTest {
        dao.insert(point("client-1", tripId = "trip-9", at = 42L))
        val row = dao.unsent().single()
        assertEquals("trip-9", row.tripId)
        assertEquals(42L, row.atEpochMs)
        assertEquals(52.5, row.lat, 0.0)
        assertEquals(13.4, row.lng, 0.0)
        assertTrue(!row.uploaded)
    }
}
