package com.elilaltd.roadwisefleet.core.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * The driver's offline store. `exportSchema` is off in A1 (the schema is the
 * only one); from v2 on, every schema change ships an explicit migration —
 * see docs/android-architecture.md §8.
 */
@Database(
    entities = [TripEntity::class, OutboxEntity::class, PendingCaptureEntity::class, GpsPointEntity::class],
    version = 2,
    exportSchema = false,
)
abstract class RoadwiseDatabase : RoomDatabase() {
    abstract fun tripDao(): TripDao
    abstract fun outboxDao(): OutboxDao
    abstract fun captureDao(): CaptureDao
    abstract fun gpsPointDao(): GpsPointDao

    companion object {
        private const val NAME = "roadwisefleet-driver.db"

        /**
         * v1 → v2 (board #106, AND1-A4): the GPS sample store plus the trip's
         * `tracking` flag. Additive — one new column with a default, one new
         * table and one new index, no existing column touched. Room validates
         * the result against the compiled schema on open, so a typo here fails
         * the device, not the driver's data.
         */
        val MIGRATION_1_2: Migration = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `trips` ADD COLUMN `tracking` INTEGER NOT NULL DEFAULT 0")
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `gps_points` (" +
                        "`clientId` TEXT NOT NULL, `tripId` TEXT NOT NULL, " +
                        "`atEpochMs` INTEGER NOT NULL, `lat` REAL NOT NULL, `lng` REAL NOT NULL, " +
                        "`accuracyM` INTEGER, `uploaded` INTEGER NOT NULL, " +
                        "PRIMARY KEY(`clientId`))",
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_gps_points_tripId_uploaded` " +
                        "ON `gps_points` (`tripId`, `uploaded`)",
                )
            }
        }

        @Volatile
        private var instance: RoadwiseDatabase? = null

        fun get(context: Context): RoadwiseDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    RoadwiseDatabase::class.java,
                    NAME,
                ).addMigrations(MIGRATION_1_2).build().also { instance = it }
            }
    }
}
