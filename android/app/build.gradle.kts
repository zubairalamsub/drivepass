plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.drivepass.android"
    // targetSdk 36 from day one: Play requires API 36 for new apps and updates
    // from 2026-08-31, and retrofitting the Android 15/16 behaviour changes into
    // a process that holds decrypted vault material is the wrong order.
    compileSdk = 36

    defaultConfig {
        applicationId = "com.drivepass.android"
        // 26 is the lowest level where AutofillService exists at all, and it is
        // what makes java.util.Base64 and PBKDF2WithHmacSHA256 available.
        minSdk = 26
        targetSdk = 36
        versionCode = 2
        versionName = "0.2.0-preview"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    kotlinOptions {
        jvmTarget = "11"
    }
    buildFeatures {
        compose = true
    }
    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.7")

    val compose = "1.7.6"
    implementation("androidx.compose.ui:ui:$compose")
    implementation("androidx.compose.ui:ui-graphics:$compose")
    implementation("androidx.compose.foundation:foundation:$compose")
    implementation("androidx.compose.material3:material3:1.3.1")
    debugImplementation("androidx.compose.ui:ui-tooling:$compose")
    implementation("androidx.compose.ui:ui-tooling-preview:$compose")

    implementation("org.json:json:20240303")

    // Drive sign-in: the Identity AuthorizationClient, which hands back an OAuth
    // access token for the drive.file scope. Pulled in only for that — the Drive
    // REST calls themselves are hand-rolled in DriveClient.kt.
    implementation("com.google.android.gms:play-services-auth:21.3.0")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
}
