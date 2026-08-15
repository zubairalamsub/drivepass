plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    // From Kotlin 2.0 the Compose compiler ships as its own plugin, versioned
    // with Kotlin rather than with Compose.
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
}
