// Accounts-payable inboxes per recipient profile id (stand-in for the recipient's master data).
// The address comes from here, never from the invoice text. verifier/profiles/empfaenger/*.json has no address
// field, and adding one would change the pinned profile hashes. All domains are .example and land in Mailpit.
export const AP_INBOX={
 'bau-isar':'eingangsrechnungen@bau-isar.example',
 'hv-giesing':'eingangsrechnungen@hv-giesing.example',
};
export const SENDER='rechnung@huber-elektrotechnik.example';
