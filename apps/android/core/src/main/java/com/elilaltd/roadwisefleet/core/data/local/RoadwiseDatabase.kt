package com.elilaltd.roadwisefleet.core.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

/**
 * The driver's offline store. `exportSchema` is off in A1 (the schema is the
 * only one); the first schema change must switch it on and commit the schema
 * with an explicit migration — see docs/android-architecture.md.
 */
@Database(
    entities = [TripEntity::class, OutboxEntity::class, PendingCaptureEntity::class],
    version = 1,
    exportSchema = false,
)
abstract class RoadwiseDatabase : RoomDatabase() {
    abstract fun tripDao(): TripDao
    abstract fun outboxDao(): OutboxDao
    abstract fun captureDao(): CaptureDao

    companion object {
        private const val NAME = "roadwisefleet-driver.db"

        @Volatile
        private var instance: RoadwiseDatabase? = null

        fun get(context: Context): RoadwiseDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    RoadwiseDatabase::class.java,
                    NAME,
                ).build().also { instance = it }
            }
    }
}
