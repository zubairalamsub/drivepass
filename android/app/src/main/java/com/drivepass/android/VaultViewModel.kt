package com.drivepass.android

import android.app.Application
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.FileNotFoundException
import javax.crypto.Cipher

/** Where an opened vault was read from, and what it takes to re-read it. */
sealed interface VaultSource {
    /** The bundled demo vault: no file, no account, nothing to re-read. */
    data object Demo : VaultSource

    /** A file chosen through the system picker, held by a content URI. */
    data class File(val uri: Uri) : VaultSource

    /** A file fetched from Google Drive over the network. */
    data class Drive(val fileId: String) : VaultSource
}

/** A vault file that has been read and whose envelope parsed; not yet unlocked. */
data class OpenedVault(
    val name: String,
    val envelope: VaultEnvelope,
    val source: VaultSource,
) {
    val isDemo get() = source is VaultSource.Demo

    /** Came from Drive rather than a picked file — the unlock screen says so. */
    val isFromDrive get() = source is VaultSource.Drive

    /** The picked-file URI, when this vault came from the system picker. */
    val uri: Uri? get() = (source as? VaultSource.File)?.uri
}

/** The last vault opened from a file, remembered so it is one tap next time. */
data class RecentVault(val uri: Uri, val name: String, val openedAt: Long)

sealed interface UiState {
    data class Welcome(
        val recent: RecentVault?,
        val loading: Boolean = false,
        val error: String? = null,
        /** A Drive sign-in or fetch is in flight. */
        val driveBusy: Boolean = false,
    ) : UiState

    data class Unlock(
        val vault: OpenedVault,
        val busy: Boolean = false,
        val error: String? = null,
        val wrongPassword: Boolean = false,
        val quick: QuickState = QuickState(),
    ) : UiState

    data class Unlocked(
        val vault: OpenedVault,
        val entries: List<Entry>,
        /** Show the one-time "set up quick unlock?" prompt over the vault. */
        val offerQuickSetup: Boolean = false,
        /** What is enrolled right now, so the manage dialog stays in step. */
        val quick: QuickState = QuickState(),
    ) : UiState
}

/** Which quick-unlock methods are usable for the vault currently on screen. */
data class QuickState(
    val biometric: Boolean = false,
    val pin: Boolean = false,
    val pinAttemptsLeft: Int = QuickUnlock.MAX_PIN_ATTEMPTS,
) {
    val any get() = biometric || pin
}

/**
 * Owns everything that must outlive a recomposition or a rotation — above all
 * the decrypted entries, which previously lived in `remember` and were thrown
 * away (re-locking the vault) every time the phone turned sideways.
 *
 * Decrypted material is deliberately never put in saved-instance state: that
 * Bundle is persisted by the system and would write the vault to disk.
 */
class VaultViewModel(app: Application) : AndroidViewModel(app) {

    private val prefs = app.getSharedPreferences("drivepass", Context.MODE_PRIVATE)
    private val _state = MutableStateFlow<UiState>(UiState.Welcome(loadRecent()))
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var autoLockJob: Job? = null
    private var backgroundedAt = 0L

    /**
     * The derived vault key for the open session, held so quick unlock can be
     * enrolled after the unlock rather than only during it. Zeroed whenever the
     * vault locks, alongside dropping the decrypted entries.
     */
    private var sessionKey: ByteArray? = null

    /** Which quick-unlock methods apply to [vault]; none for the demo. */
    private fun quickState(vault: OpenedVault): QuickState {
        if (vault.isDemo || !QuickUnlock.matches(prefs, vault.envelope)) return QuickState()
        return QuickState(
            biometric = QuickUnlock.hasBiometric(prefs),
            pin = QuickUnlock.hasPin(prefs),
            pinAttemptsLeft = QuickUnlock.pinAttemptsLeft(prefs),
        )
    }

    private fun unlockState(vault: OpenedVault) = UiState.Unlock(vault, quick = quickState(vault))

    /** What is enrolled, without reference to a vault — for the open vault. */
    private fun quickStatusNow() = QuickState(
        biometric = QuickUnlock.hasBiometric(prefs),
        pin = QuickUnlock.hasPin(prefs),
        pinAttemptsLeft = QuickUnlock.pinAttemptsLeft(prefs),
    )

    /** Common tail of every successful unlock, whichever method got us here. */
    private fun opened(vault: OpenedVault, key: ByteArray, entries: List<Entry>, offerSetup: Boolean) {
        sessionKey?.fill(0)
        sessionKey = key
        (vault.source as? VaultSource.File)?.let { rememberRecent(it.uri, vault.name) }
        _state.value = UiState.Unlocked(
            vault,
            entries,
            offerQuickSetup = offerSetup && !vault.isDemo && !QuickUnlock.isSetUp(prefs),
            quick = quickStatusNow(),
        )
    }

    // ---- Opening a file ------------------------------------------------------

    fun openPicked(uri: Uri) = open(uri, fromRecent = false)

    fun openRecent() {
        loadRecent()?.let { open(it.uri, fromRecent = true) }
    }

    fun openDemo() {
        val json = getApplication<Application>().assets.open("fixture-vault.enc")
            .bufferedReader().use { it.readText() }
        _state.value = unlockState(OpenedVault("Demo vault", VaultCrypto.parseEnvelope(json), VaultSource.Demo))
    }

    private fun open(uri: Uri, fromRecent: Boolean) {
        _state.value = UiState.Welcome(loadRecent(), loading = true)
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { read(uri) } }
            result.fold(
                onSuccess = { vault ->
                    if (!fromRecent) rememberRecent(uri, vault.name)
                    _state.value = unlockState(vault)
                },
                onFailure = { e ->
                    // A remembered file that has gone away (deleted, moved, or its
                    // grant revoked) is not coming back; offering it again would
                    // only fail the same way.
                    if (fromRecent && (e is FileNotFoundException || e is SecurityException)) forgetRecent()
                    _state.value = UiState.Welcome(loadRecent(), error = describe(e))
                },
            )
        }
    }

    private fun read(uri: Uri): OpenedVault {
        val cr = getApplication<Application>().contentResolver
        val name = runCatching {
            cr.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
                if (it.moveToFirst()) it.getString(0) else null
            }
        }.getOrNull() ?: uri.lastPathSegment ?: "vault.enc"
        val text = cr.openInputStream(uri)?.use { input ->
            // A real vault is kilobytes. Refuse to pull an arbitrary large file
            // into memory just because it was picked by mistake.
            val bytes = input.readNBytesCompat(MAX_FILE_BYTES + 1)
            if (bytes.size > MAX_FILE_BYTES) throw FileTooLarge()
            String(bytes, Charsets.UTF_8)
        } ?: throw FileNotFoundException()
        // Parse now, not after the user has typed their password: a wrong file
        // should be reported the moment it is picked.
        return OpenedVault(name, VaultCrypto.parseEnvelope(text), VaultSource.File(uri))
    }

    // ---- Unlocking -----------------------------------------------------------

    fun unlock(password: CharArray) {
        val s = _state.value as? UiState.Unlock ?: return
        if (s.busy) return
        _state.value = s.copy(busy = true, error = null, wrongPassword = false)
        viewModelScope.launch {
            val result = withContext(Dispatchers.Default) {
                runCatching {
                    val key = VaultCrypto.deriveKey(password, s.vault.envelope.salt, s.vault.envelope.iterations)
                    try {
                        key to VaultModel.liveSorted(VaultModel.parse(VaultCrypto.decrypt(key, s.vault.envelope)))
                    } catch (e: Throwable) {
                        // Only hold on to the key if it actually opened the vault.
                        key.fill(0)
                        throw e
                    } finally {
                        password.fill('\u0000')
                    }
                }
            }
            result.fold(
                onSuccess = { (key, entries) -> opened(s.vault, key, entries, offerSetup = true) },
                onFailure = { e ->
                    _state.value = s.copy(
                        busy = false,
                        error = describe(e),
                        wrongPassword = e is VaultError.WrongPassword,
                    )
                },
            )
        }
    }

    /**
     * Drop the decrypted entries and return to the unlock screen for the same
     * vault, re-reading the file so an edit made on another device since it was
     * opened is what gets unlocked next.
     */
    fun lock() {
        autoLockJob?.cancel()
        sessionKey?.fill(0)
        sessionKey = null
        val vault = when (val s = _state.value) {
            is UiState.Unlocked -> s.vault
            is UiState.Unlock -> s.vault
            is UiState.Welcome -> return
        }
        _state.value = unlockState(vault)
        val source = vault.source
        if (source is VaultSource.Demo) return
        viewModelScope.launch {
            val fresh = withContext(Dispatchers.IO) {
                runCatching {
                    when (source) {
                        is VaultSource.File -> read(source.uri)
                        // Without a live token the re-read is skipped and the
                        // already-parsed envelope stands; the user can still
                        // unlock, just without picking up a remote edit.
                        is VaultSource.Drive -> driveToken?.let { readDrive(it, source.fileId, vault.name) }
                        VaultSource.Demo -> null
                    }
                }.getOrNull()
            } ?: return@launch
            val now = _state.value
            if (now is UiState.Unlock && now.vault.source == source && !now.busy) _state.value = now.copy(vault = fresh)
        }
    }

    fun closeVault() {
        autoLockJob?.cancel()
        sessionKey?.fill(0)
        sessionKey = null
        _state.value = UiState.Welcome(loadRecent())
    }

    // ---- Auto-lock -----------------------------------------------------------

    fun onBackgrounded() {
        if (_state.value !is UiState.Unlocked) return
        backgroundedAt = System.currentTimeMillis()
        autoLockJob?.cancel()
        // Locks even while the app sits in the background, so the decrypted
        // vault is not left in memory indefinitely. The check in onForegrounded
        // covers the case where the process was frozen and this never ran.
        autoLockJob = viewModelScope.launch {
            delay(AUTO_LOCK_MS)
            lock()
        }
    }

    fun onForegrounded() {
        autoLockJob?.cancel()
        if (_state.value is UiState.Unlocked && backgroundedAt != 0L &&
            System.currentTimeMillis() - backgroundedAt >= AUTO_LOCK_MS
        ) {
            lock()
        }
        backgroundedAt = 0L
    }

    // ---- Quick unlock --------------------------------------------------------

    /** A Cipher for BiometricPrompt, or null if the stored key is unusable. */
    fun beginBiometricUnlock(): Cipher? {
        val s = _state.value as? UiState.Unlock ?: return null
        return try {
            QuickUnlock.beginBiometricUnlock(prefs)
        } catch (e: Throwable) {
            _state.value = s.copy(error = describe(e), quick = quickState(s.vault))
            null
        }
    }

    /** The fingerprint matched; the cipher can now unwrap the vault key. */
    fun completeBiometricUnlock(cipher: Cipher) {
        val s = _state.value as? UiState.Unlock ?: return
        if (s.busy) return
        _state.value = s.copy(busy = true, error = null)
        viewModelScope.launch {
            val key = runCatching { QuickUnlock.finishBiometricUnlock(prefs, cipher) }.getOrElse { e ->
                _state.value = s.copy(busy = false, error = describe(e), quick = quickState(s.vault))
                return@launch
            }
            openWithKey(s, key)
        }
    }

    fun unlockWithPin(pin: CharArray) {
        val s = _state.value as? UiState.Unlock ?: return
        if (s.busy) return
        _state.value = s.copy(busy = true, error = null, wrongPassword = false)
        viewModelScope.launch {
            val key = withContext(Dispatchers.Default) {
                runCatching { QuickUnlock.unlockWithPin(prefs, pin) }
            }.getOrElse { e ->
                pin.fill('\u0000')
                _state.value = s.copy(busy = false, error = describe(e), quick = quickState(s.vault))
                return@launch
            }
            pin.fill('\u0000')
            openWithKey(s, key)
        }
    }

    /** Shared tail: decrypt with a key quick unlock recovered. */
    private suspend fun openWithKey(s: UiState.Unlock, key: ByteArray) {
        val result = withContext(Dispatchers.Default) {
            runCatching {
                try {
                    VaultModel.liveSorted(VaultModel.parse(VaultCrypto.decrypt(key, s.vault.envelope)))
                } catch (e: Throwable) {
                    key.fill(0)
                    throw e
                }
            }
        }
        result.fold(
            onSuccess = { entries -> opened(s.vault, key, entries, offerSetup = false) },
            onFailure = { e ->
                // A stored key that no longer opens this vault is stale, not a
                // typo — the master password must have changed. Stop offering it.
                if (e is VaultError.WrongPassword) QuickUnlock.disable(prefs)
                _state.value = s.copy(
                    busy = false,
                    error = if (e is VaultError.WrongPassword)
                        "This vault's master password has changed, so quick unlock was reset."
                    else describe(e),
                    quick = quickState(s.vault),
                )
            },
        )
    }

    // ---- Quick unlock enrolment ----------------------------------------------

    fun beginBiometricEnrol(): Cipher? = runCatching { QuickUnlock.beginBiometricEnrol() }.getOrNull()

    fun completeBiometricEnrol(cipher: Cipher) {
        val s = _state.value as? UiState.Unlocked ?: return
        val key = sessionKey ?: return
        runCatching { QuickUnlock.finishBiometricEnrol(prefs, cipher, key, s.vault.envelope) }
        _state.value = s.copy(offerQuickSetup = false, quick = quickStatusNow())
    }

    fun enablePin(pin: CharArray) {
        val s = _state.value as? UiState.Unlocked ?: return
        val key = sessionKey ?: return
        viewModelScope.launch {
            withContext(Dispatchers.Default) {
                runCatching { QuickUnlock.enablePin(prefs, pin, key, s.vault.envelope) }
                pin.fill('\u0000')
            }
            (_state.value as? UiState.Unlocked)?.let {
                _state.value = it.copy(offerQuickSetup = false, quick = quickStatusNow())
            }
        }
    }

    fun disableQuickUnlock() {
        QuickUnlock.disable(prefs)
        when (val s = _state.value) {
            is UiState.Unlocked -> _state.value = s.copy(offerQuickSetup = false, quick = QuickState())
            is UiState.Unlock -> _state.value = s.copy(quick = QuickState())
            is UiState.Welcome -> Unit
        }
    }

    fun dismissQuickSetup() {
        (_state.value as? UiState.Unlocked)?.let { _state.value = it.copy(offerQuickSetup = false) }
    }

    /** The biometric prompt failed for a reason worth showing. */
    fun quickUnlockFailed(message: String?) {
        val s = _state.value as? UiState.Unlock ?: return
        _state.value = s.copy(busy = false, error = message, quick = quickState(s.vault))
    }

    // ---- Google Drive --------------------------------------------------------

    /**
     * Access token for the current Drive session.
     *
     * Memory only, and cleared on every failure. Persisting it would leave a
     * live Drive credential on disk, which is the thing this app goes out of its
     * way not to do with the vault key.
     */
    private var driveToken: String? = null

    /** The account picker / consent screen is up; show the spinner meanwhile. */
    fun driveConnecting() {
        (_state.value as? UiState.Welcome)?.let { _state.value = it.copy(driveBusy = true, error = null) }
    }

    /** The UI has an access token for drive.file — go find the vault. */
    fun openFromDrive(token: String) {
        driveToken = token
        _state.value = UiState.Welcome(loadRecent(), driveBusy = true)
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { findAndReadDrive(token) } }
            result.fold(
                onSuccess = { _state.value = unlockState(it) },
                onFailure = { e ->
                    driveToken = null
                    _state.value = UiState.Welcome(loadRecent(), error = describe(e))
                },
            )
        }
    }

    /** Sign-in was cancelled, or Play Services refused to authorize. */
    fun driveFailed(message: String?) {
        driveToken = null
        _state.value = UiState.Welcome(
            loadRecent(),
            error = message ?: "Google sign-in didn't complete. Try again, or choose the file instead.",
        )
    }

    private fun findAndReadDrive(token: String): OpenedVault {
        val file = DriveClient.findVault(token) ?: throw NoVaultInDrive()
        return readDrive(token, file.id, file.name)
    }

    private fun readDrive(token: String, fileId: String, name: String): OpenedVault =
        OpenedVault(name, VaultCrypto.parseEnvelope(DriveClient.download(token, fileId)), VaultSource.Drive(fileId))

    // ---- Recent vault --------------------------------------------------------

    private fun rememberRecent(uri: Uri, name: String) {
        // Not every provider grants persistable access; without it the recent
        // entry still works until the device restarts, which is fine.
        runCatching {
            getApplication<Application>().contentResolver
                .takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        prefs.edit()
            .putString(KEY_URI, uri.toString())
            .putString(KEY_NAME, name)
            .putLong(KEY_OPENED, System.currentTimeMillis())
            .apply()
    }

    fun forgetRecent() {
        loadRecent()?.let { r ->
            runCatching {
                getApplication<Application>().contentResolver
                    .releasePersistableUriPermission(r.uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        }
        prefs.edit().remove(KEY_URI).remove(KEY_NAME).remove(KEY_OPENED).apply()
        (_state.value as? UiState.Welcome)?.let { _state.value = it.copy(recent = null) }
    }

    private fun loadRecent(): RecentVault? {
        val uri = prefs.getString(KEY_URI, null) ?: return null
        return RecentVault(Uri.parse(uri), prefs.getString(KEY_NAME, null) ?: "vault.enc", prefs.getLong(KEY_OPENED, 0))
    }

    fun dismissError() {
        (_state.value as? UiState.Welcome)?.let { _state.value = it.copy(error = null) }
    }

    private class FileTooLarge : Exception()

    /** Signed in, but the drive.file scope exposes no vault.enc to this app. */
    private class NoVaultInDrive : Exception()

    companion object {
        /** How long the app may sit in the background before the vault locks. */
        const val AUTO_LOCK_MS = 5 * 60_000L
        private const val MAX_FILE_BYTES = 32 * 1024 * 1024

        private const val KEY_URI = "recent_uri"
        private const val KEY_NAME = "recent_name"
        private const val KEY_OPENED = "recent_opened"

        /** Turn an exception into a sentence a user can act on. */
        fun describe(e: Throwable): String = when (e) {
            is VaultError.WrongPassword -> "That password didn't unlock this vault. Check it and try again."
            is VaultError.UnrecognizedFormat, is VaultError.UnsupportedKdf ->
                "This file isn't a DrivePass vault. Choose the vault.enc file your extension saved to Google Drive."
            is VaultError.Corrupt -> "This vault file looks damaged (${e.message?.substringAfter(": ")})."
            is VaultError -> e.message ?: "This vault file can't be opened."
            is FileTooLarge -> "That file is far too large to be a DrivePass vault."
            // drive.file only exposes files the project created or the user
            // opened for it. An Android client in the same Cloud project as the
            // extension does see the extension's vault.enc; this is the fallback
            // for the case where no vault has been created at all yet.
            is NoVaultInDrive ->
                "Signed in, but Google Drive isn't sharing a vault.enc with this app yet. " +
                    "Use Choose vault file once to grant access to it."
            is DriveClient.Unauthorized -> "Google sign-in has expired. Connect Google Drive again."
            is DriveClient.Offline -> "Couldn't reach Google Drive. Check your connection and try again."
            is DriveClient.DriveError -> e.message ?: "Google Drive couldn't be read."
            is QuickUnlock.BadPin ->
                if (e.attemptsLeft == 0) "Too many wrong PINs. Quick unlock was turned off — use your master password."
                else "Wrong PIN. ${e.attemptsLeft} ${if (e.attemptsLeft == 1) "try" else "tries"} left."
            is QuickUnlock.BiometricsChanged ->
                "Fingerprints on this device changed, so quick unlock was reset. Unlock with your master password to set it up again."
            is QuickUnlock.WrongVault ->
                "Quick unlock was set up for a different vault. Use your master password."
            is FileNotFoundException -> "That file couldn't be opened. It may have been moved or deleted."
            is SecurityException -> "DrivePass no longer has permission to open that file. Choose it again."
            else -> "Something went wrong: ${e.message ?: e::class.java.simpleName}"
        }
    }
}

/** InputStream.readNBytes is API 33; read up to [max] bytes on any level. */
private fun java.io.InputStream.readNBytesCompat(max: Int): ByteArray {
    val out = java.io.ByteArrayOutputStream()
    val buf = ByteArray(8192)
    while (out.size() < max) {
        val n = read(buf, 0, minOf(buf.size, max - out.size()))
        if (n < 0) break
        out.write(buf, 0, n)
    }
    return out.toByteArray()
}
