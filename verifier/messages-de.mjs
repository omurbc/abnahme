// German texts for EN16931 / XRechnung rule codes. KoSIT reports BR-DE-* already in German;
// EN16931 rules (BR-*, BR-CO-*, BR-S-*, BR-AE-*) and PEPPOL rules come in English and need this table.
export const MESSAGES_DE={
 'BR-02':'Die Rechnungsnummer (BT-1) fehlt.',
 'BR-06':'Der Name des Verkäufers (BT-27) fehlt.',
 'BR-07':'Der Name des Käufers (BT-44) fehlt.',
 'BR-16':'Die Rechnung enthält keine Rechnungsposition (BG-25).',
 'BR-CO-10':'Die Summe der Nettobeträge der Positionen (BT-106) stimmt nicht mit der Summe der einzelnen Positionsnettobeträge (BT-131) überein.',
 'BR-CO-13':'Der Gesamtbetrag ohne Umsatzsteuer (BT-109) stimmt nicht: Er muss der Summe der Positionen (BT-106) abzüglich Nachlässen (BT-107) zuzüglich Zuschlägen (BT-108) entsprechen.',
 'BR-CO-15':'Der Gesamtbetrag einschließlich Umsatzsteuer (BT-112) muss dem Betrag ohne Umsatzsteuer (BT-109) zuzüglich der Umsatzsteuer (BT-110) entsprechen.',
 'BR-CO-16':'Der Zahlbetrag (BT-115) muss dem Bruttobetrag (BT-112) abzüglich bereits gezahlter Beträge (BT-113) zuzüglich Rundung (BT-114) entsprechen.',
 'BR-CO-25':'Bei positivem Zahlbetrag muss ein Fälligkeitsdatum (BT-9) oder Zahlungsbedingungen (BT-20) angegeben sein.',
 'BR-S-02':'Positionen mit Umsatzsteuer-Kategorie „S“ erfordern die USt-IdNr. (BT-31) oder Steuernummer (BT-32) des Verkäufers.',
 'BR-S-08':'Für jeden Steuersatz der Kategorie „S“ muss der steuerpflichtige Betrag (BT-116) der Summe der Positionsnettobeträge dieses Satzes entsprechen.',
 'BR-S-09':'Der Steuerbetrag der Kategorie „S“ (BT-117) muss dem steuerpflichtigen Betrag (BT-116) mal Steuersatz (BT-119) entsprechen.',
 'BR-AE-01':'Eine Rechnung mit Positionen in Kategorie „AE“ (Steuerschuldnerschaft des Leistungsempfängers) braucht genau eine Steueraufschlüsselung (BG-23) mit Kategorie „AE“.',
 'BR-AE-02':'Bei Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG, Kategorie „AE“) müssen die USt-IdNr. des Verkäufers (BT-31) und die USt-IdNr. des Käufers (BT-48) bzw. dessen Registernummer (BT-47) angegeben sein.',
 'BR-AE-05':'In Positionen der Kategorie „AE“ muss der Umsatzsteuersatz (BT-152) 0 sein.',
 'BR-AE-08':'In der Steueraufschlüsselung der Kategorie „AE“ muss der steuerpflichtige Betrag (BT-116) der Summe der Positionsnettobeträge in Kategorie „AE“ entsprechen.',
 'BR-AE-09':'Der Steuerbetrag der Kategorie „AE“ (BT-117) muss 0 sein.',
 'BR-AE-10':'Die Steueraufschlüsselung der Kategorie „AE“ braucht einen Befreiungsgrund (BT-120) oder Befreiungscode (BT-121), z. B. „Steuerschuldnerschaft des Leistungsempfängers“.',
 'BR-DE-1':'Die Zahlungsanweisungen (BG-16) fehlen.',
 'BR-DE-2':'Die Kontaktdaten des Verkäufers (BG-6) fehlen.',
 'BR-DE-3':'Der Ort des Verkäufers (BT-37) fehlt.',
 'BR-DE-4':'Die Postleitzahl des Verkäufers (BT-38) fehlt.',
 'BR-DE-5':'Der Ansprechpartner des Verkäufers (BT-41) fehlt.',
 'BR-DE-6':'Die Telefonnummer des Verkäufers (BT-42) fehlt.',
 'BR-DE-7':'Die E-Mail-Adresse des Verkäufers (BT-43) fehlt.',
 'BR-DE-8':'Der Ort des Käufers (BT-52) fehlt.',
 'BR-DE-9':'Die Postleitzahl des Käufers (BT-53) fehlt.',
 'BR-DE-15':'Die Käuferreferenz (BT-10, z. B. Leitweg-ID oder Bestellzeichen) fehlt.',
 'BR-DE-16':'Bei steuerpflichtigen Umsätzen fehlt die USt-IdNr. (BT-31) oder Steuernummer (BT-32) des Verkäufers.',
 'BR-DE-17':'Die Rechnungsart (BT-3) soll einer der Codes 326, 380, 384, 389, 381, 875, 876 oder 877 sein.',
 'BR-DE-21':'Die Spezifikationskennung (BT-24) entspricht nicht der XRechnung.',
 'BR-DE-23-a':'Bei Überweisung (Code 30/58) müssen Kontoangaben (BG-17) übermittelt werden.',
 'PEPPOL-EN16931-R010':'Die elektronische Adresse des Käufers (BT-49) fehlt.',
 'PEPPOL-EN16931-R020':'Die elektronische Adresse des Verkäufers (BT-34) fehlt.',
 'KOSIT-SCENARIO':'Der KoSIT-Prüfer hat nicht das im Abnahmeprofil festgelegte XRechnung-Szenario angewendet; die deutschen XRechnung-Regeln wurden also nicht geprüft.',
};

// KoSIT German texts look like "[BR-DE-15] Das Element ..."; strip the code prefix.
const stripCode=text=>text.replace(/^\[[^\]]+\]\s*-?\s*/,'');
export function textDe(code,kositText=''){
 if(MESSAGES_DE[code])return MESSAGES_DE[code];
 if(code.startsWith('BR-DE-')&&kositText)return stripCode(kositText);
 if(code.startsWith('KOSIT-HTTP-'))return `Der KoSIT-Prüfer konnte das Dokument nicht verarbeiten (HTTP ${code.slice(11)}).`;
 return `${code}: ${stripCode(kositText)}`.trim();
}
