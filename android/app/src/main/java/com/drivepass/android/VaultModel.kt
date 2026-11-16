package com.drivepass.android

import org.json.JSONArray
import org.json.JSONObject

/**
 * The decrypted payload's entry model, matching newEntry() in src/lib/vault.js
 * field for field. Unknown fields are preserved verbatim in [raw] so a
 * round-trip through this client never drops data a newer desktop release added.
 */
data class Entry(
    val id: String,
    val type: String,
    val name: String,
    val url: String,
    val username: String,
    val password: String,
    val totp: String,
    val notes: String,
    val favorite: Boolean,
    val createdAt: Long,
    val updatedAt: Long,
    val deletedAt: Long?,
    val cardNumber: String,
    val cardHolder: String,
    val cardExpMonth: String,
    val cardExpYear: String,
    val cardCvv: String,
    val passkeyUserName: String,
    val passkeyRpId: String,
    val tags: List<String>,
    val raw: JSONObject,
) {
    val isDeleted get() = deletedAt != null

    /** "MM/YY" the way it is printed on the card, or "" when unset. */
    val cardExpiry: String
        get() {
            if (cardExpMonth.isEmpty()) return cardExpYear
            if (cardExpYear.isEmpty()) return cardExpMonth.padStart(2, '0')
            return cardExpMonth.padStart(2, '0') + "/" + cardExpYear.takeLast(2)
        }

    /** The secondary line the desktop UI shows for this entry. */
    fun subtitle(): String = when (type) {
        "card" -> if (cardNumber.isNotEmpty()) "•••• " + cardNumber.takeLast(4) else "Credit Card"
        "note" -> "Secure Note"
        "passkey" -> passkeyUserName.ifEmpty { "Passkey" }
        else -> username.ifEmpty { url }
    }

    /**
     * Back to JSON, written OVER a deep copy of [raw] rather than built from
     * scratch.
     *
     * This is the whole reason writes are safe. This model does not read
     * `history`, does not read `passkey.credentialId`, and knows nothing about
     * fields a newer desktop release may have added. Constructing a fresh
     * object from the Kotlin properties would silently delete all of them —
     * killing passkeys and losing password history on the first edit made from
     * the phone. Copying first and overwriting only what this model owns means
     * anything unmodelled survives untouched.
     *
     * Nested objects are mutated in place for the same reason: replacing
     * `card` or `passkey` wholesale would drop their unmodelled keys.
     *
     * One deliberate normalisation: [tags] drops blank entries at parse time,
     * so blank tags do not survive a round trip. Nothing produces them.
     */
    fun toJson(): JSONObject {
        val o = JSONObject(raw.toString())
        o.put("id", id)
        o.put("type", type)
        o.put("name", name)
        o.put("url", url)
        o.put("username", username)
        o.put("password", password)
        o.put("totp", totp)
        o.put("notes", notes)
        o.put("favorite", favorite)
        o.put("createdAt", createdAt)
        o.put("updatedAt", updatedAt)
        // An explicit JSON null, not an absent key: the extension writes
        // `deletedAt: null` for live entries and reads it with a null check.
        o.put("deletedAt", deletedAt ?: JSONObject.NULL)

        val anyCard = cardNumber.isNotEmpty() || cardHolder.isNotEmpty() ||
            cardExpMonth.isNotEmpty() || cardExpYear.isNotEmpty() || cardCvv.isNotEmpty()
        if (o.has("card") || anyCard) {
            val card = o.optJSONObject("card") ?: JSONObject().also { o.put("card", it) }
            card.put("number", cardNumber)
            card.put("holder", cardHolder)
            card.put("expMonth", cardExpMonth)
            card.put("expYear", cardExpYear)
            card.put("cvv", cardCvv)
        }

        if (o.has("passkey") || passkeyUserName.isNotEmpty() || passkeyRpId.isNotEmpty()) {
            val passkey = o.optJSONObject("passkey") ?: JSONObject().also { o.put("passkey", it) }
            // credentialId is deliberately NOT written: it is not in this model,
            // and the deep copy already carries whatever was there.
            passkey.put("userName", passkeyUserName)
            passkey.put("rpId", passkeyRpId)
        }

        if (o.has("tags") || tags.isNotEmpty()) o.put("tags", JSONArray(tags))
        return o
    }
}

/**
 * A decrypted vault payload.
 *
 * [root] is the payload object as it was parsed, kept so that serialising back
 * preserves top-level keys this client does not model. Note that data-class
 * equality compares it by reference; nothing relies on comparing VaultData.
 */
data class VaultData(
    val entries: List<Entry>,
    val purged: List<String>,
    val root: JSONObject = JSONObject(),
)

/**
 * The fields an editor may change.
 *
 * Deliberately NOT the whole [Entry]: `history`, `passkey` and anything a newer
 * desktop release added are carried over from the existing entry rather than
 * round-tripped through the UI, so the editor cannot drop what it cannot show.
 *
 * Never put this in rememberSaveable — it holds a password, and saved-instance
 * state is written to disk by the system.
 */
data class EntryDraft(
    val id: String? = null,
    val type: String = "login",
    val name: String = "",
    val url: String = "",
    val username: String = "",
    val password: String = "",
    val totp: String = "",
    val notes: String = "",
    val favorite: Boolean = false,
    val cardNumber: String = "",
    val cardHolder: String = "",
    val cardExpMonth: String = "",
    val cardExpYear: String = "",
    val cardCvv: String = "",
) {
    /** For sealing an unsaved edit across an auto-lock; see [EditSession]. */
    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id ?: JSONObject.NULL)
        put("type", type)
        put("name", name)
        put("url", url)
        put("username", username)
        put("password", password)
        put("totp", totp)
        put("notes", notes)
        put("favorite", favorite)
        put("cardNumber", cardNumber)
        put("cardHolder", cardHolder)
        put("cardExpMonth", cardExpMonth)
        put("cardExpYear", cardExpYear)
        put("cardCvv", cardCvv)
    }

    companion object {
        /** Prefill from an existing entry, for editing. */
        fun of(e: Entry) = EntryDraft(
            id = e.id, type = e.type, name = e.name, url = e.url,
            username = e.username, password = e.password, totp = e.totp,
            notes = e.notes, favorite = e.favorite,
            cardNumber = e.cardNumber, cardHolder = e.cardHolder,
            cardExpMonth = e.cardExpMonth, cardExpYear = e.cardExpYear, cardCvv = e.cardCvv,
        )

        fun fromJson(o: JSONObject) = EntryDraft(
            id = if (o.isNull("id")) null else o.optString("id"),
            type = o.optString("type", "login"),
            name = o.optString("name"),
            url = o.optString("url"),
            username = o.optString("username"),
            password = o.optString("password"),
            totp = o.optString("totp"),
            notes = o.optString("notes"),
            favorite = o.optBoolean("favorite"),
            cardNumber = o.optString("cardNumber"),
            cardHolder = o.optString("cardHolder"),
            cardExpMonth = o.optString("cardExpMonth"),
            cardExpYear = o.optString("cardExpYear"),
            cardCvv = o.optString("cardCvv"),
        )
    }
}

/**
 * An open editor: what it started from, and what it holds now.
 *
 * Both halves are kept so a restored editor still knows what "unchanged"
 * means — Cancel then asks before discarding, exactly as it did before the
 * lock interrupted.
 */
data class EditSession(val initial: EntryDraft, val current: EntryDraft) {
    val dirty get() = current != initial

    fun toJson(): String =
        JSONObject().put("initial", initial.toJson()).put("current", current.toJson()).toString()

    companion object {
        fun fromJson(s: String): EditSession {
            val o = JSONObject(s)
            return EditSession(
                EntryDraft.fromJson(o.getJSONObject("initial")),
                EntryDraft.fromJson(o.getJSONObject("current")),
            )
        }
    }
}

object VaultModel {

    /** What the extension keeps; see handleSaveEntry in the service worker. */
    private const val MAX_HISTORY = 10

    fun parse(plaintextJson: String): VaultData {
        val root = JSONObject(plaintextJson)
        val arr = root.optJSONArray("entries") ?: JSONArray()
        val entries = (0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.let { fromJson(it) }
        }
        val purgedArr = root.optJSONArray("purged") ?: JSONArray()
        val purged = (0 until purgedArr.length()).map { purgedArr.getString(it) }
        return VaultData(entries, purged, root)
    }

    /**
     * The payload back to JSON, preserving unmodelled top-level keys.
     *
     * Works on a deep copy, so serialising never mutates the parsed data — a
     * save that fails partway must leave the in-memory vault exactly as it was.
     */
    fun serialize(data: VaultData): String {
        val root = JSONObject(data.root.toString())
        root.put("entries", JSONArray().apply { data.entries.forEach { put(it.toJson()) } })
        if (root.has("purged") || data.purged.isNotEmpty()) {
            root.put("purged", JSONArray(data.purged))
        }
        return root.toString()
    }

    /**
     * Add or update an entry, mirroring handleSaveEntry in the extension's
     * service worker.
     *
     * The old password is pushed onto `history` only when the entry already had
     * one, the draft has one, and they differ — the same three conditions the
     * desktop checks. History is capped at [MAX_HISTORY], oldest dropped.
     *
     * Saving un-deletes: an edit sets deletedAt back to null, which is what the
     * desktop does and what makes "restore by editing" work.
     */
    fun upsert(data: VaultData, draft: EntryDraft): VaultData {
        val now = System.currentTimeMillis()
        val existing = draft.id?.let { id -> data.entries.firstOrNull { it.id == id } }

        // Start from the existing JSON so history, passkey.credentialId and any
        // unmodelled field survive an edit made here.
        val base = existing?.raw?.let { JSONObject(it.toString() ) } ?: JSONObject().apply {
            put("createdAt", now)
            put("history", JSONArray())
        }

        if (existing != null &&
            draft.password.isNotEmpty() &&
            existing.password.isNotEmpty() &&
            draft.password != existing.password
        ) {
            val previous = base.optJSONArray("history") ?: JSONArray()
            val rolled = JSONArray().put(
                JSONObject()
                    .put("password", existing.password)
                    .put("updatedAt", if (existing.updatedAt != 0L) existing.updatedAt else now),
            )
            for (i in 0 until minOf(previous.length(), MAX_HISTORY - 1)) rolled.put(previous.get(i))
            base.put("history", rolled)
        }

        val merged = Entry(
            id = existing?.id ?: draft.id?.takeIf { it.isNotEmpty() } ?: java.util.UUID.randomUUID().toString(),
            type = draft.type,
            name = draft.name,
            url = draft.url,
            username = draft.username,
            password = draft.password,
            totp = draft.totp,
            notes = draft.notes,
            favorite = draft.favorite,
            createdAt = base.optLong("createdAt").takeIf { it != 0L } ?: now,
            updatedAt = now,
            deletedAt = null,
            cardNumber = draft.cardNumber,
            cardHolder = draft.cardHolder,
            cardExpMonth = draft.cardExpMonth,
            cardExpYear = draft.cardExpYear,
            cardCvv = draft.cardCvv,
            // Not editable here, so carried through rather than blanked.
            passkeyUserName = existing?.passkeyUserName.orEmpty(),
            passkeyRpId = existing?.passkeyRpId.orEmpty(),
            tags = existing?.tags.orEmpty(),
            raw = base,
        )
        val entry = fromJson(merged.toJson())

        val entries = if (existing == null) data.entries + entry
        else data.entries.map { if (it.id == entry.id) entry else it }
        return data.copy(entries = entries)
    }

    /**
     * Soft delete: a tombstone, never a removal.
     *
     * Hard delete is `purgeEntry` on the desktop, which also appends to the
     * `purged` list — an irreversible cross-device instruction. This client does
     * not do that; the extension owns the Trash.
     */
    fun softDelete(data: VaultData, id: String): VaultData = stamp(data, id) { o, now ->
        o.put("deletedAt", now)
    }

    /** Undo a soft delete, for the Undo affordance after one. */
    fun restore(data: VaultData, id: String): VaultData = stamp(data, id) { o, _ ->
        o.put("deletedAt", JSONObject.NULL)
    }

    private inline fun stamp(data: VaultData, id: String, change: (JSONObject, Long) -> Unit): VaultData {
        val now = System.currentTimeMillis()
        val entries = data.entries.map { e ->
            if (e.id != id) e else {
                val o = JSONObject(e.raw.toString())
                change(o, now)
                o.put("updatedAt", now)
                fromJson(o)
            }
        }
        return data.copy(entries = entries)
    }

    /**
     * Merge two decrypted vaults by entry id, last-write-wins on updatedAt.
     *
     * A direct port of mergeVaults() in src/lib/vault.js. Two details there are
     * load-bearing and easy to get wrong:
     *
     *  - The comparison is `>=`, so LOCAL WINS TIES. Reversing it would make
     *    the remote win whenever two clocks happen to agree.
     *  - Purged ids are removed from the result AFTER merging, so a hard delete
     *    on either side cannot be undone by the other side still holding the
     *    entry.
     *
     * Insertion order follows the JS Map: remote first, then local-only entries
     * appended, with an overwrite keeping the original position.
     *
     * One deliberate divergence: the extension returns a bare
     * `{entries, purged}` and so discards unmodelled top-level keys. This keeps
     * [local]'s root instead, which is strictly safer and reads identically.
     */
    fun merge(local: VaultData, remote: VaultData): VaultData {
        val purged = LinkedHashSet<String>().apply {
            addAll(local.purged)
            addAll(remote.purged)
        }
        val byId = LinkedHashMap<String, Entry>()
        for (e in remote.entries) byId[e.id] = e
        for (e in local.entries) {
            val existing = byId[e.id]
            if (existing == null || e.updatedAt >= existing.updatedAt) byId[e.id] = e
        }
        for (id in purged) byId.remove(id)
        return VaultData(byId.values.toList(), purged.toList(), local.root)
    }

    private fun fromJson(o: JSONObject): Entry {
        val card = o.optJSONObject("card")
        val passkey = o.optJSONObject("passkey")
        // deletedAt is `null` for live entries — JSONObject.isNull distinguishes
        // an explicit JSON null from an absent key, and both mean "live".
        val deleted = if (o.isNull("deletedAt")) null else o.optLong("deletedAt").takeIf { it != 0L }
        return Entry(
            id = o.optString("id"),
            type = o.optString("type", "login").ifEmpty { "login" },
            name = o.optString("name"),
            url = o.optString("url"),
            username = o.optString("username"),
            password = o.optString("password"),
            totp = o.optString("totp"),
            notes = o.optString("notes"),
            favorite = o.optBoolean("favorite", false),
            createdAt = o.optLong("createdAt"),
            updatedAt = o.optLong("updatedAt"),
            deletedAt = deleted,
            cardNumber = card?.optString("number") ?: "",
            cardHolder = card?.optString("holder") ?: "",
            cardExpMonth = card?.optString("expMonth") ?: "",
            cardExpYear = card?.optString("expYear") ?: "",
            cardCvv = card?.optString("cvv") ?: "",
            passkeyUserName = passkey?.optString("userName") ?: "",
            passkeyRpId = passkey?.optString("rpId") ?: "",
            tags = o.optJSONArray("tags")?.let { t -> (0 until t.length()).map { t.optString(it) } }
                ?.filter { it.isNotBlank() }.orEmpty(),
            raw = o,
        )
    }

    /**
     * Live entries in the desktop's display order: favourites first, then by
     * name. The desktop uses String.localeCompare for the name comparison, so
     * use a Collator rather than Kotlin's default ordering — otherwise case and
     * accents sort differently and the two clients disagree visibly.
     */
    fun liveSorted(data: VaultData): List<Entry> {
        val collator = java.text.Collator.getInstance().apply {
            strength = java.text.Collator.TERTIARY
        }
        return data.entries
            .filter { !it.isDeleted }
            .sortedWith(
                compareByDescending<Entry> { it.favorite }
                    .thenComparator { a, b ->
                        collator.compare(a.name.ifEmpty { a.url }, b.name.ifEmpty { b.url })
                    }
            )
    }
}
