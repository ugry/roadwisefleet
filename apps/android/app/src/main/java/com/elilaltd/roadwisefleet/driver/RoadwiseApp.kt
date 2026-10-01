package com.elilaltd.roadwisefleet.driver

import android.app.Application
import com.elilaltd.roadwisefleet.driver.di.AppContainer

/**
 * Application entry point. The container is built once and owns the process
 * lifetime of the database, the sync engine and the push registrar; the sync
 * engine is started here so the outbox drains even if the UI is not open yet.
 */
class RoadwiseApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        container.syncEngine.start()
    }
}
