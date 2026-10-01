package com.elilaltd.roadwisefleet.core.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface TripDao {
    @Query("SELECT * FROM trips ORDER BY updatedAtEpochMs DESC")
    fun observeAll(): Flow<List<TripEntity>>

    @Query("SELECT * FROM trips WHERE id = :id")
    suspend fun byId(id: String): TripEntity?

    @Upsert
    suspend fun upsertAll(trips: List<TripEntity>)

    @Query("DELETE FROM trips")
    suspend fun clear()

    @Query("SELECT COUNT(*) FROM trips")
    suspend fun count(): Int
}

@Dao
interface OutboxDao {
    @Query("SELECT * FROM outbox ORDER BY createdAtEpochMs ASC")
    fun observeAll(): Flow<List<OutboxEntity>>

    @Query("SELECT * FROM outbox ORDER BY createdAtEpochMs ASC")
    suspend fun all(): List<OutboxEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(item: OutboxEntity)

    @Query("DELETE FROM outbox WHERE id = :id")
    suspend fun delete(id: String)

    @Query("UPDATE outbox SET attempts = :attempts, lastError = :error WHERE id = :id")
    suspend fun update(id: String, attempts: Int, error: String?)

    @Query("SELECT COUNT(*) FROM outbox")
    suspend fun count(): Int
}

@Dao
interface CaptureDao {
    @Query("SELECT * FROM pending_captures ORDER BY capturedAtEpochMs ASC")
    suspend fun all(): List<PendingCaptureEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(capture: PendingCaptureEntity)

    @Query("DELETE FROM pending_captures WHERE id = :id")
    suspend fun delete(id: String)

    @Query("SELECT COUNT(*) FROM pending_captures")
    suspend fun count(): Int
}

/**
 * The GPS sample store (board #106, AND1-A4). `insert` IGNOREs on a duplicate
 * client id, so a retried sample is a no-op; the flush reads the unsent rows
 * oldest-first, uploads them in batches and purges what was accepted.
 */
@Dao
interface GpsPointDao {
    @Query("SELECT * FROM gps_points WHERE uploaded = 0 ORDER BY atEpochMs ASC")
    suspend fun unsent(): List<GpsPointEntity>

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(point: GpsPointEntity)

    @Query("UPDATE gps_points SET uploaded = 1 WHERE clientId IN (:ids)")
    suspend fun markUploaded(ids: List<String>)

    @Query("DELETE FROM gps_points WHERE uploaded = 1")
    suspend fun purgeUploaded()

    @Query("SELECT COUNT(*) FROM gps_points WHERE uploaded = 0")
    suspend fun pendingCount(): Int

    @Query("SELECT MAX(atEpochMs) FROM gps_points WHERE tripId = :tripId")
    suspend fun lastSampleAt(tripId: String): Long?
}
