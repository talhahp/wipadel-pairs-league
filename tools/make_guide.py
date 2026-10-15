"""
Builds the two-page player guide PDF.

    python tools/make_guide.py

Output: assets/docs/wi-padel-pairs-league-player-guide.pdf

The rules here must stay in step with the Rules screen (assets/js/views.js) and
with the scoring in assets/js/core.js. Points and tie-breaks are written out in
full rather than summarised, because this is the copy players will argue over
at the club.

Typeface is Helvetica, one of the PDF base-14 fonts: it needs no embedding, so
the file stays small and there is no font licence to worry about when the guide
is forwarded around WhatsApp.
"""

import json
import os
import re
import urllib.error
import urllib.request

import segno
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.utils import ImageReader
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.pdfgen import canvas as pdfcanvas
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table, TableStyle,
    Image, KeepTogether,
)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_DIR = os.path.join(ROOT, "assets", "docs")
OUT = os.path.join(OUT_DIR, "wi-padel-pairs-league-player-guide.pdf")
LOGO = os.path.join(ROOT, "assets", "img", "wi-padel-logo.png")
SITE = "https://talhahp.github.io/wipadel-pairs-league/"
LEAGUE = os.environ.get("LEAGUE", "sherwood")


def _config():
    """Read the Supabase URL and public key out of the site's own config."""
    try:
        with open(os.path.join(ROOT, "assets", "js", "config.js"), encoding="utf-8") as fh:
            txt = fh.read()
        url = re.search(r"SUPABASE_URL\s*=\s*'([^']*)'", txt)
        key = re.search(r"SUPABASE_ANON_KEY\s*=\s*'([^']*)'", txt)
        return (url.group(1) if url else ""), (key.group(1) if key else "")
    except OSError:
        return "", ""


def _get(path):
    url, key = _config()
    if not url or not key:
        return None
    req = urllib.request.Request(
        f"{url}/rest/v1/{path}",
        headers={"apikey": key, "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def division_rows():
    """
    Each division's real shape, read from the live league.

    Hard coding "7 pairs, 12 matches" went stale within a day of being written,
    because pairs kept joining. Ask the database instead.
    """
    try:
        divisions = _get(f"divisions?select=id,name,meetings,sort_order"
                         f"&league_id=eq.{LEAGUE}&order=sort_order")
        teams = _get("teams?select=id,division_id")
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        print(f"  (could not reach the league, leaving the division table out: {e})")
        return []
    if divisions is None or teams is None:
        print("  (no Supabase keys in config.js, leaving the division table out)")
        return []

    counts = {}
    for t in teams:
        counts[t["division_id"]] = counts.get(t["division_id"], 0) + 1

    rows = []
    for d in divisions:
        n = counts.get(d["id"], 0)
        if n < 2:
            continue
        meet = d.get("meetings") or 1
        how = {1: "Once", 2: "Twice, home and away"}.get(meet, f"{meet} times")
        rows.append([d["name"], str(n), how, str((n - 1) * meet)])
    return rows

# Brand palette, same values as assets/css/app.css.
NAVY = colors.HexColor("#000B7A")
INK = colors.HexColor("#04061C")
AZURE = colors.HexColor("#3D94FF")
ORANGE = colors.HexColor("#FF7800")
LIME = colors.HexColor("#78F700")
LIME_DARK = colors.HexColor("#4E8C00")   # legible as text on white
PAPER = colors.HexColor("#EDF2FA")
GREY = colors.HexColor("#5A6478")
RULE = colors.HexColor("#C9D6EA")

PAGE_W, PAGE_H = A4
MARGIN = 16 * mm

# ----------------------------------------------------------------- styles

def style(name, **kw):
    base = dict(name=name, fontName="Helvetica", fontSize=9.1, leading=12.2,
                textColor=INK, alignment=TA_LEFT)
    base.update(kw)
    return ParagraphStyle(**base)

S = {
    "h1": style("h1", fontName="Helvetica-Bold", fontSize=19, leading=21,
                textColor=NAVY, spaceAfter=1),
    "sub": style("sub", fontSize=10, leading=13, textColor=GREY),
    "h2": style("h2", fontName="Helvetica-Bold", fontSize=11, leading=13,
                textColor=NAVY, spaceBefore=7.5, spaceAfter=3),
    "body": style("body", spaceAfter=4),
    "bullet": style("bullet", leftIndent=11, bulletIndent=1, spaceAfter=1.9),
    "small": style("small", fontSize=8.4, leading=11.4, textColor=GREY),
    "callout": style("callout", fontSize=10.6, leading=15, textColor=NAVY),
    "stepno": style("stepno", fontName="Helvetica-Bold", fontSize=15,
                    leading=16, textColor=AZURE),
    "steph": style("steph", fontName="Helvetica-Bold", fontSize=10.2,
                   leading=13, textColor=INK),
    "stepb": style("stepb", fontSize=8.9, leading=11.5, textColor=GREY),
    "th": style("th", fontName="Helvetica-Bold", fontSize=8.6, leading=11,
                textColor=colors.white),
    "td": style("td", fontSize=9.3, leading=12.4),
    "tdb": style("tdb", fontName="Helvetica-Bold", fontSize=9.3, leading=12.4),
}


def P(text, s="body"):
    return Paragraph(text, S[s])


def bullets(items):
    return [Paragraph(t, S["bullet"], bulletText="•") for t in items]



def callout(text, tint=PAPER, bar=AZURE):
    """A tinted box with a coloured bar down the left edge."""
    t = Table([[P(text, "callout")]], colWidths=[PAGE_W - 2 * MARGIN])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), tint),
        ("LEFTPADDING", (0, 0), (-1, -1), 12),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 9),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
        ("LINEBEFORE", (0, 0), (0, -1), 3, bar),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    return t


def steps(rows):
    data = [[P(str(i + 1), "stepno"),
             [P(h, "steph"), P(b, "stepb")]]
            for i, (h, b) in enumerate(rows)]
    t = Table(data, colWidths=[13 * mm, PAGE_W - 2 * MARGIN - 13 * mm])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 3.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
        ("LEFTPADDING", (0, 0), (0, -1), 2),
        ("LINEBELOW", (0, 0), (-1, -2), 0.5, RULE),
    ]))
    return t


def grid(header, rows, widths, highlight_col=None):
    data = [[P(h, "th") for h in header]]
    for r in rows:
        data.append([P(c, "tdb") if i == 0 else P(c, "td") for i, c in enumerate(r)])
    t = Table(data, colWidths=widths, repeatRows=1)
    st = [
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("LINEBELOW", (0, 1), (-1, -2), 0.5, RULE),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PAPER]),
        ("BOX", (0, 0), (-1, -1), 0.6, RULE),
    ]
    if highlight_col is not None:
        st += [("TEXTCOLOR", (highlight_col, 1), (highlight_col, -1), LIME_DARK),
               ("FONTNAME", (highlight_col, 1), (highlight_col, -1), "Helvetica-Bold")]
    t.setStyle(TableStyle(st))
    return t


# ------------------------------------------------------------ page frame

class NumberedCanvas(pdfcanvas.Canvas):
    """Stamps "Page N of M" once M is known, i.e. at save time."""

    def __init__(self, *args, **kw):
        super().__init__(*args, **kw)
        self._saved = []

    def showPage(self):
        self._saved.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self._saved)
        for state in self._saved:
            self.__dict__.update(state)
            self._footer(total)
            super().showPage()
        super().save()

    def _footer(self, total):
        self.saveState()
        self.setFont("Helvetica", 7.6)
        self.setFillColor(GREY)
        self.drawString(MARGIN, 11 * mm,
                        "Wi Padel Sherwood Pairs League  ·  15 October – 15 December 2026")
        self.drawRightString(PAGE_W - MARGIN, 11 * mm, f"Page {self._pageNumber} of {total}")
        self.setStrokeColor(RULE)
        self.setLineWidth(0.5)
        self.line(MARGIN, 14.5 * mm, PAGE_W - MARGIN, 14.5 * mm)
        self.restoreState()


HEADER_H = 25 * mm   # masthead band reserved at the top of every page


def decorate(canvas, doc):
    """Masthead on every page. The footer is drawn by NumberedCanvas."""
    canvas.saveState()

    logo_w = 32 * mm
    logo_h = logo_w * 533 / 900
    top = PAGE_H - MARGIN
    canvas.drawImage(ImageReader(LOGO), MARGIN, top - logo_h, width=logo_w,
                     height=logo_h, mask="auto")

    x = MARGIN + logo_w + 5 * mm
    canvas.setFillColor(NAVY)
    canvas.setFont("Helvetica-Bold", 17)
    canvas.drawString(x, top - 11 * mm, "PAIRS LEAGUE")
    canvas.setFillColor(GREY)
    canvas.setFont("Helvetica", 9.4)
    canvas.drawString(x, top - 15.5 * mm,
                      "Player guide  ·  Wi Padel Sherwood  ·  15 October – 15 December 2026")

    y = top - logo_h - 2 * mm
    canvas.setStrokeColor(NAVY)
    canvas.setLineWidth(2.4)
    canvas.line(MARGIN, y, PAGE_W - MARGIN - 26 * mm, y)
    canvas.setStrokeColor(LIME)
    canvas.line(PAGE_W - MARGIN - 24 * mm, y, PAGE_W - MARGIN, y)

    canvas.restoreState()




# ----------------------------------------------------------------- build

def build():
    os.makedirs(OUT_DIR, exist_ok=True)

    qr_png = os.path.join(HERE, "_qr.png")
    segno.make(SITE, error="m").save(qr_png, scale=10, border=1,
                                     dark="#000B7A", light="#FFFFFF")

    doc = BaseDocTemplate(
        OUT, pagesize=A4,
        leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=MARGIN, bottomMargin=20 * mm,
        title="Wi Padel Sherwood Pairs League - Player Guide",
        author="Wi Padel Sherwood",
        subject="League format, scoring and rules",
    )
    frame = Frame(MARGIN, 20 * mm, PAGE_W - 2 * MARGIN,
                  PAGE_H - MARGIN - HEADER_H - 20 * mm, id="body",
                  leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([PageTemplate(id="page", frames=[frame], onPage=decorate)])

    f = []
    f.append(callout(
        "<b>Play when you want, compete when you can.</b> Every pair plays every other pair "
        "in their division. There is no set order and no fixed night: you arrange each match "
        "directly with your opponents and play it whenever suits you both, as long as they "
        "are all done by 15 December."))
    f.append(Spacer(1, 4))

    f.append(P("Getting a match played", "h2"))
    f.append(steps([
        ("Find who you still have to play",
         "Open the league site, pick your pair once, and you get your own page: every "
         "fixture, split into still-to-play and played, with your opponents' WhatsApp numbers."),
        ("Whoever is marked “messages first” starts the chat",
         "They suggest two or three date and time options. Either pair can start it. The rule "
         "only exists so both sides are not sitting waiting for the other."),
        ("Book a 90-minute court",
         "Either pair books at Wi Padel Sherwood on Playtomic. All league bookings are 20% off "
         "automatically; there is no code to enter."),
        ("Submit the score, then post it in the group",
         "One player enters it on the site, and also posts the score in the WhatsApp group with "
         "the date and time you played. The table updates the moment it is submitted."),
    ]))

    divisions = division_rows()
    if divisions:
        f.append(P("Your division", "h2"))
        f.append(grid(
            ["DIVISION", "PAIRS", "YOU PLAY EACH OTHER PAIR", "YOUR MATCHES"],
            divisions,
            [38 * mm, 20 * mm, PAGE_W - 2 * MARGIN - 86 * mm, 28 * mm],
            highlight_col=3))
        if any("home and away" in r[2] for r in divisions):
            f.append(Spacer(1, 4))
            f.append(P(
                "Where a division plays home and away, the two meetings are separate matches, "
                "each scored on its own, and who makes first contact swaps between them. They "
                "need not be played in order.", "body"))

    f.append(P("How a match is played", "h2"))
    f.extend(bullets([
        "<b>Two regular sets.</b> A set is won at 6 games with two clear, or 7–5, or 7–6 on a tie-break.",
        "<b>Star point at deuce</b> (sudden death). This keeps matches inside 60–90 minutes so "
        "the court is free on time.",
        "<b>If the sets finish 1–1, a 10-point super tie-break decides the match.</b> First to 10, "
        "win by two clear points.",
        "There is never a third full set.",
    ]))

    f.append(P("Points", "h2"))
    f.append(P(
        "Three points are shared out in every single match, however it finishes:", "body"))
    f.append(Spacer(1, 3))
    f.append(grid(
        ["", "WINNER", "LOSER", "WHERE THE POINTS COME FROM"],
        [["Won 2–0", "3", "0", "Two sets won, plus the point for winning the match"],
         ["Won on the super tie-break", "2", "1", "One set each; the winner adds the match point"]],
        [48 * mm, 24 * mm, 22 * mm, PAGE_W - 2 * MARGIN - 94 * mm],
        highlight_col=1))
    f.append(Spacer(1, 6))
    f.append(callout(
        "The rule underneath both lines: <b>one point for every full set you win, plus one point "
        "for winning the match.</b> The super tie-break is <b>not</b> a set. It only decides who "
        "takes that match point, so you keep a point for a set you won even if you lose the match.",
        tint=colors.HexColor("#F2FBE0"), bar=LIME))

    # Not wrapped in KeepTogether: holding this table whole pushes the guide to
    # three pages. It splits with its header repeated, which reads fine.
    f.append(P("Three worked examples", "h2"))
    f.append(grid(
        ["SCORE", "RESULT", "POINTS"],
        [["6–3, 6–4", "Won in straight sets", "3 – 0"],
         ["6–4, 3–6, 10–8", "Lost set two, won the tie-break", "2 – 1"],
         ["4–6, 6–2, 8–10", "Won a set, lost the tie-break", "1 – 2"]],
        [46 * mm, 62 * mm, PAGE_W - 2 * MARGIN - 108 * mm],
        highlight_col=2))

    f.append(P("How the table is ordered", "h2"))
    f.append(P(
        "Pairs level on total points are separated in this order:", "body"))
    f.extend(bullets([
        "<b>1. Head-to-head</b>, the points you took from each other.",
        "<b>2. Sets won</b>, total full sets across all your matches.",
        "<b>3. Game difference</b>, games won minus games conceded, counting full sets only.",
    ]))

    f.append(P("Deadlines", "h2"))
    f.extend(bullets([
        "<b>Every match must be finished by Monday 15 December 2026.</b>",
        "We strongly recommend having <b>about half of them played by 15 November</b>. Leaving them "
        "to the end means fighting everyone else for the same courts.",
    ]))

    f.append(P("Substitutes", "h2"))
    f.append(P(
        "If your partner is injured or away, you may use <b>one substitute for that match</b>. "
        "The substitute's Playtomic rating must be at or below your division cap: "
        "<b>1.5 for Beginner, 3.0 for Intermediate</b>. The result counts normally.", "body"))

    f.append(P("Balls", "h2"))
    f.append(P(
        "Balls are <b>not provided</b> and are not included in your court booking. If you want a "
        "new tin for your match, the pairs buy it themselves. Split the cost between the two "
        "pairs, or make your own arrangement, as long as you sort it out before you play.", "body"))

    f.append(P("Submitting results", "h2"))
    f.extend(bullets([
        "Either player from the <b>winning pair</b> submits the score on the site.",
        "<b>Post the score in the WhatsApp group as well</b>, with the date and time the match "
        "was played.",
        "A match can only be submitted <b>once</b>, and it cannot be overwritten, so check the "
        "score before you send it.",
        "Got it wrong? Message the organiser and it will be corrected.",
        "Only completed, legal scorelines are accepted, so a typo will be refused rather than "
        "quietly saved.",
    ]))

    f.append(P("A few pointers", "h2"))
    f.extend(bullets([
        "Book the court as soon as you agree a time. Slots get scarce towards the end of the season.",
        "Get there a few minutes early. Your warm up comes out of the 90 minutes.",
        "If you have to call a match off, tell your opponents as early as you can and offer another time.",
        "Message the other pair directly instead of asking in the group. Their numbers are on the site.",
        "Check the grid now and then to see who you still owe a match.",
    ]))

    # Closing block: where everything lives, with a QR to the site.
    qr = Image(qr_png, width=24 * mm, height=24 * mm)
    right = [
        Paragraph("Everything is on the league site", S["steph"]),
        Spacer(1, 3),
        Paragraph(
            "Fixtures, contact numbers, the live table, the cross grid of who has played who, "
            "and the score form. Scan the code or go to:", S["stepb"]),
        Spacer(1, 3),
        Paragraph(f'<font color="#000B7A"><b>{SITE}</b></font>', S["td"]),
        Spacer(1, 3),
        Paragraph("Pick your pair once and the site remembers you on that phone.", S["small"]),
    ]
    box = Table([[qr, right]], colWidths=[30 * mm, PAGE_W - 2 * MARGIN - 30 * mm])
    box.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), PAPER),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (0, 0), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (1, 0), (1, 0), 12),
        ("LINEBEFORE", (0, 0), (0, -1), 3, AZURE),
    ]))
    f.append(Spacer(1, 7))
    f.append(KeepTogether(box))

    doc.build(f, canvasmaker=NumberedCanvas)
    os.remove(qr_png)

    from pypdf import PdfReader
    pages = len(PdfReader(OUT).pages)
    if pages > 2:
        print(f"NOTE: {pages} pages. Two fit on one double-sided sheet, which is "
              f"easier to hand out at the club.")

    print(f"Wrote {OUT} ({os.path.getsize(OUT) // 1024} KB, {pages} pages)")


if __name__ == "__main__":
    build()
