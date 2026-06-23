#!/usr/bin/env python3
from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    BaseDocTemplate,
    Flowable,
    Frame,
    Image,
    KeepTogether,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.pdfgen.canvas import Canvas

ROOT = Path(__file__).resolve().parent
DATA_PATH = ROOT / "report-data.json"
OUT_PATH = ROOT / "mailing-list-health-report-2026-06-05.pdf"

PAGE_W, PAGE_H = letter
MARGIN_X = 0.72 * inch
MARGIN_TOP = 0.70 * inch
MARGIN_BOTTOM = 0.62 * inch
CONTENT_W = PAGE_W - 2 * MARGIN_X

INK = colors.HexColor("#1F2430")
MUTED = colors.HexColor("#697184")
GRID = colors.HexColor("#E5E8F0")
PANEL = colors.white
SURFACE = colors.HexColor("#FCFCFD")
BLUE = colors.HexColor("#5477C4")
BLUE_LIGHT = colors.HexColor("#CEDFFE")
BLUE_XLIGHT = colors.HexColor("#EAF1FE")
GOLD = colors.HexColor("#B8A037")
GOLD_LIGHT = colors.HexColor("#FFEA8F")
ORANGE = colors.HexColor("#CC6F47")
ORANGE_LIGHT = colors.HexColor("#FFBDA1")
OLIVE = colors.HexColor("#71B436")
OLIVE_LIGHT = colors.HexColor("#BEEB96")
PINK = colors.HexColor("#BD569B")
PINK_LIGHT = colors.HexColor("#F5BACC")
NEUTRAL = colors.HexColor("#C5CAD3")
NEUTRAL_LIGHT = colors.HexColor("#E2E5EA")
NEUTRAL_XLIGHT = colors.HexColor("#F4F5F7")
NEUTRAL_DARK = colors.HexColor("#464C55")


def fmt_int(value) -> str:
    if value is None:
        return "Not available"
    return f"{int(value):,}"


def fmt_pct(value, digits=1) -> str:
    if value is None:
        return "Not available"
    return f"{value * 100:.{digits}f}%"


def clean_label(value: str, max_chars=58) -> str:
    if len(value) <= max_chars:
        return value
    return value[: max_chars - 1].rstrip() + "..."


def display_list_name(value: str) -> str:
    replacements = {
        "LP Pipeline 2026 06 05": "Limited Partner Pipeline 2026 06 05",
        "Amols 5k": "Amols five thousand",
    }
    return replacements.get(value, value)


def parse_date(value: str | None) -> str:
    if not value:
        return ""
    try:
        if len(value) == 10:
            dt = datetime.fromisoformat(value)
        else:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return dt.strftime("%B %-d, %Y")
    except Exception:
        return value


class NumberedCanvas(Canvas):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._saved_page_states = []

    def showPage(self):
        self._saved_page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        page_count = len(self._saved_page_states)
        for state in self._saved_page_states:
            self.__dict__.update(state)
            draw_footer(self, page_count)
            super().showPage()
        super().save()


def draw_footer(canvas: Canvas, page_count: int):
    page_num = canvas.getPageNumber()
    canvas.saveState()
    canvas.setStrokeColor(GRID)
    canvas.setLineWidth(0.5)
    canvas.line(MARGIN_X, 0.48 * inch, PAGE_W - MARGIN_X, 0.48 * inch)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 7.5)
    canvas.drawString(MARGIN_X, 0.31 * inch, "Mailing list health report")
    canvas.drawRightString(PAGE_W - MARGIN_X, 0.31 * inch, f"Page {page_num} of {page_count}")
    canvas.restoreState()


class Card(Flowable):
    def __init__(self, title, value, note, width, accent=BLUE):
        super().__init__()
        self.title = title
        self.value = value
        self.note = note
        self.width = width
        self.height = 0.82 * inch
        self.accent = accent

    def draw(self):
        c = self.canv
        c.saveState()
        c.setFillColor(PANEL)
        c.setStrokeColor(GRID)
        c.roundRect(0, 0, self.width, self.height, 6, fill=1, stroke=1)
        c.setFillColor(self.accent)
        c.roundRect(0, 0, 0.075 * inch, self.height, 4, fill=1, stroke=0)
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 7.5)
        c.drawString(0.16 * inch, self.height - 0.23 * inch, self.title.upper())
        c.setFillColor(INK)
        c.setFont("Helvetica-Bold", 17)
        c.drawString(0.16 * inch, self.height - 0.50 * inch, self.value)
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 7.4)
        c.drawString(0.16 * inch, self.height - 0.70 * inch, self.note)
        c.restoreState()


class HorizontalBarChart(Flowable):
    def __init__(self, title, subtitle, rows, width=CONTENT_W, height=None, color=BLUE, value_suffix=""):
        super().__init__()
        self.title = title
        self.subtitle = subtitle
        self.rows = rows
        self.width = width
        self.height = height or (0.88 * inch + 0.34 * inch * len(rows))
        self.color = color
        self.value_suffix = value_suffix

    def draw(self):
        c = self.canv
        c.saveState()
        c.setFillColor(PANEL)
        c.setStrokeColor(GRID)
        c.roundRect(0, 0, self.width, self.height, 7, fill=1, stroke=1)
        c.setFillColor(INK)
        c.setFont("Helvetica-Bold", 10.5)
        c.drawString(0.18 * inch, self.height - 0.27 * inch, self.title)
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 8)
        c.drawString(0.18 * inch, self.height - 0.45 * inch, self.subtitle)

        left = 2.15 * inch
        right = self.width - 0.62 * inch
        bar_w = right - left
        y = self.height - 0.78 * inch
        max_value = max([r[1] for r in self.rows] + [1])
        for label, value in self.rows:
            y -= 0.33 * inch
            c.setFillColor(INK)
            c.setFont("Helvetica", 7.8)
            c.drawRightString(left - 0.10 * inch, y + 0.03 * inch, clean_label(label, 29))
            c.setFillColor(NEUTRAL_XLIGHT)
            c.roundRect(left, y - 0.02 * inch, bar_w, 0.14 * inch, 3, fill=1, stroke=0)
            fill_w = bar_w * (value / max_value)
            c.setFillColor(self.color)
            c.roundRect(left, y - 0.02 * inch, fill_w, 0.14 * inch, 3, fill=1, stroke=0)
            c.setFillColor(INK)
            c.setFont("Helvetica-Bold", 7.6)
            c.drawString(left + fill_w + 0.05 * inch, y + 0.005 * inch, f"{fmt_int(value)}{self.value_suffix}")
        c.restoreState()


class StackedBarChart(Flowable):
    def __init__(self, title, subtitle, rows, segments, width=CONTENT_W, height=None):
        super().__init__()
        self.title = title
        self.subtitle = subtitle
        self.rows = rows
        self.segments = segments
        self.width = width
        self.height = height or (0.90 * inch + 0.36 * inch * len(rows))

    def draw(self):
        c = self.canv
        c.saveState()
        c.setFillColor(PANEL)
        c.setStrokeColor(GRID)
        c.roundRect(0, 0, self.width, self.height, 7, fill=1, stroke=1)
        c.setFillColor(INK)
        c.setFont("Helvetica-Bold", 10.5)
        c.drawString(0.18 * inch, self.height - 0.27 * inch, self.title)
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 8)
        c.drawString(0.18 * inch, self.height - 0.45 * inch, self.subtitle)

        legend_x = 0.18 * inch
        legend_y = self.height - 0.66 * inch
        for name, color in self.segments:
            c.setFillColor(color)
            c.roundRect(legend_x, legend_y, 0.13 * inch, 0.08 * inch, 2, fill=1, stroke=0)
            c.setFillColor(MUTED)
            c.setFont("Helvetica", 7)
            c.drawString(legend_x + 0.17 * inch, legend_y - 0.005 * inch, name)
            legend_x += 1.20 * inch

        left = 2.25 * inch
        right = self.width - 0.70 * inch
        bar_w = right - left
        y = self.height - 0.94 * inch
        max_total = max([sum(v for _, v in row["values"]) for row in self.rows] + [1])
        for row in self.rows:
            y -= 0.36 * inch
            total = sum(v for _, v in row["values"])
            c.setFillColor(INK)
            c.setFont("Helvetica", 7.6)
            c.drawRightString(left - 0.10 * inch, y + 0.035 * inch, clean_label(row["label"], 30))
            x = left
            for (name, value), (_, color) in zip(row["values"], self.segments):
                if not value:
                    continue
                w = bar_w * (value / max_total)
                c.setFillColor(color)
                c.rect(x, y - 0.02 * inch, w, 0.16 * inch, fill=1, stroke=0)
                x += w
            c.setFillColor(INK)
            c.setFont("Helvetica-Bold", 7.4)
            c.drawString(left + bar_w + 0.05 * inch, y + 0.012 * inch, fmt_int(total))
        c.restoreState()


class FunnelChart(Flowable):
    def __init__(self, title, subtitle, rows, width=CONTENT_W, height=2.35 * inch):
        super().__init__()
        self.title = title
        self.subtitle = subtitle
        self.rows = rows
        self.width = width
        self.height = height

    def draw(self):
        c = self.canv
        c.saveState()
        c.setFillColor(PANEL)
        c.setStrokeColor(GRID)
        c.roundRect(0, 0, self.width, self.height, 7, fill=1, stroke=1)
        c.setFillColor(INK)
        c.setFont("Helvetica-Bold", 10.5)
        c.drawString(0.18 * inch, self.height - 0.27 * inch, self.title)
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 8)
        c.drawString(0.18 * inch, self.height - 0.45 * inch, self.subtitle)

        left = 0.55 * inch
        top = self.height - 0.88 * inch
        max_value = max([row[1] for row in self.rows] + [1])
        colors_ = [BLUE, OLIVE, GOLD, PINK, ORANGE, NEUTRAL]
        step_h = 0.22 * inch
        for i, (label, value) in enumerate(self.rows):
            w = (self.width - 1.4 * inch) * (value / max_value)
            x = left + ((self.width - 1.4 * inch) - w) / 2
            y = top - i * 0.31 * inch
            c.setFillColor(colors_[i % len(colors_)])
            c.roundRect(x, y, w, step_h, 4, fill=1, stroke=0)
            c.setFillColor(INK)
            c.setFont("Helvetica-Bold", 7.6)
            c.drawCentredString(self.width / 2, y + 0.065 * inch, f"{label}: {fmt_int(value)}")
        c.restoreState()


class MiniTableBlock(Flowable):
    def __init__(self, title, rows, width=CONTENT_W):
        super().__init__()
        self.title = title
        self.rows = rows
        self.width = width
        self.height = 0.46 * inch + 0.25 * inch * (len(rows) + 1)

    def draw(self):
        c = self.canv
        c.saveState()
        c.setFillColor(PANEL)
        c.setStrokeColor(GRID)
        c.roundRect(0, 0, self.width, self.height, 7, fill=1, stroke=1)
        c.setFillColor(INK)
        c.setFont("Helvetica-Bold", 9.5)
        c.drawString(0.18 * inch, self.height - 0.25 * inch, self.title)
        y = self.height - 0.55 * inch
        for left, right in self.rows:
            c.setFillColor(MUTED)
            c.setFont("Helvetica", 7.6)
            c.drawString(0.18 * inch, y, left)
            c.setFillColor(INK)
            c.setFont("Helvetica-Bold", 7.6)
            c.drawRightString(self.width - 0.18 * inch, y, right)
            y -= 0.25 * inch
        c.restoreState()


def styles():
    base = getSampleStyleSheet()
    base.add(ParagraphStyle("TitleMain", fontName="Helvetica-Bold", fontSize=26, leading=30, textColor=INK, spaceAfter=9))
    base.add(ParagraphStyle("Subtitle", fontName="Helvetica", fontSize=10.5, leading=15, textColor=MUTED, spaceAfter=16))
    base.add(ParagraphStyle("Section", fontName="Helvetica-Bold", fontSize=15.5, leading=19, textColor=INK, spaceBefore=14, spaceAfter=7))
    base.add(ParagraphStyle("Subsection", fontName="Helvetica-Bold", fontSize=11.5, leading=15, textColor=INK, spaceBefore=9, spaceAfter=4))
    base.add(ParagraphStyle("Body", fontName="Helvetica", fontSize=9.5, leading=13.5, textColor=INK, spaceAfter=7))
    base.add(ParagraphStyle("Small", fontName="Helvetica", fontSize=7.7, leading=10.2, textColor=MUTED, spaceAfter=5))
    base.add(ParagraphStyle("ReportBullet", parent=base["Body"], leftIndent=12, firstLineIndent=-7, bulletIndent=0, spaceAfter=5))
    base.add(ParagraphStyle("TableBody", fontName="Helvetica", fontSize=7.5, leading=9.2, textColor=INK))
    base.add(ParagraphStyle("TableHeader", fontName="Helvetica-Bold", fontSize=7.3, leading=8.8, textColor=INK, alignment=TA_CENTER))
    base.add(ParagraphStyle("CenterSmall", fontName="Helvetica", fontSize=7.5, leading=9, textColor=MUTED, alignment=TA_CENTER))
    return base


S = styles()


def p(text, style="Body"):
    return Paragraph(text, S[style])


def bullet(text):
    return Paragraph(text, S["ReportBullet"], bulletText="•")


def make_table(data, col_widths, font_size=7.4):
    rows = []
    for r, row in enumerate(data):
        style = "TableHeader" if r == 0 else "TableBody"
        rows.append([Paragraph(str(cell), S[style]) for cell in row])
    t = Table(rows, colWidths=col_widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), BLUE_XLIGHT),
        ("TEXTCOLOR", (0, 0), (-1, 0), INK),
        ("GRID", (0, 0), (-1, -1), 0.35, GRID),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, NEUTRAL_XLIGHT]),
    ]))
    return t


def campaign_total(campaign):
    counts = campaign["counts"]
    return sum(v or 0 for v in counts.values())


def campaign_sent(campaign):
    return campaign["counts"].get("succeeded") or 0


def campaign_completion(campaign):
    total = campaign_total(campaign)
    return campaign_sent(campaign) / total if total else 0


def build():
    data = json.loads(DATA_PATH.read_text())
    lists = data["lists"]
    list_by_name = {row["name"]: row for row in lists}
    imports = data["imports"]
    campaigns = data["campaigns"]
    queue_status = {k: v.get("count") for k, v in data["queue_status"].items()}
    generated = datetime.fromisoformat(data["generated_at"].replace("Z", "+00:00")).astimezone(timezone.utc)

    total_net = sum(row["net_members"] for row in lists)
    new_list_names = {"Family Offices 2026 06 05", "High Net Worth Amols Friends 2026 06 05", "LP Pipeline 2026 06 05"}
    new_net = sum(row["net_members"] for row in lists if row["name"] in new_list_names)
    old_net = total_net - new_net
    largest = max(lists, key=lambda row: row["net_members"])
    current_lifex = next(c for c in campaigns if c["email_id"] == "532a06ae-c296-4f93-8483-e250d803f08d")
    lifex_total = campaign_total(current_lifex)
    lifex_remaining = (current_lifex["counts"].get("pending") or 0) + (current_lifex["counts"].get("processing") or 0)

    doc = BaseDocTemplate(
        str(OUT_PATH),
        pagesize=letter,
        leftMargin=MARGIN_X,
        rightMargin=MARGIN_X,
        topMargin=MARGIN_TOP,
        bottomMargin=MARGIN_BOTTOM,
        title="Mailing List Health Report",
        author="Codex",
    )
    frame = Frame(MARGIN_X, MARGIN_BOTTOM, CONTENT_W, PAGE_H - MARGIN_TOP - MARGIN_BOTTOM, id="normal")
    doc.addPageTemplates([PageTemplate(id="normal", frames=[frame])])

    story = []
    story.append(p("Mailing List Health Report", "TitleMain"))
    story.append(p(f"Prepared June 5, 2026. Database snapshot captured at {generated.strftime('%H:%M')} coordinated universal time. The report expands the mailing list summary into portfolio, campaign, engagement, and operational views.", "Subtitle"))

    card_w = (CONTENT_W - 0.24 * inch) / 3
    story.append(Table([[
        Card("Total mailing list size", fmt_int(sum(row["total_members"] for row in lists)), "all stored members", card_w, BLUE),
        Card("Net size", fmt_int(total_net), "after unsubscribed members", card_w, OLIVE),
        Card("New net addresses", fmt_int(new_net), "imported today", card_w, GOLD),
    ]], colWidths=[card_w, card_w, card_w], style=TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0,0), (-1,-1), 0), ("RIGHTPADDING", (0,0), (-1,-1), 0)])))
    story.append(Spacer(1, 0.12 * inch))
    story.append(Table([[
        Card("Largest list share", fmt_pct(largest["net_members"] / total_net), "Amols202604 share of net size", card_w, ORANGE),
        Card("Pending queue", fmt_int(queue_status.get("pending")), "not yet completed", card_w, PINK),
        Card("Tracked clicks", fmt_int(next((e["unique_recipients"] for e in data["provider_events"]["by_type"] if e["event_type"] == "clicked"), 0)), "unique recipients in event log", card_w, BLUE),
    ]], colWidths=[card_w, card_w, card_w], style=TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0,0), (-1,-1), 0), ("RIGHTPADDING", (0,0), (-1,-1), 0)])))

    story.append(p("Executive Summary", "Section"))
    story.append(bullet(f"<b>The portfolio expanded by {fmt_int(new_net)} net addresses today.</b> The new family office, high net worth, and Limited Partner Pipeline lists increase net list capacity from {fmt_int(old_net)} to {fmt_int(total_net)} members. The new family office list is the meaningful scale addition; the other two are smaller, higher-touch audiences."))
    story.append(bullet(f"<b>The program is still highly concentrated in Amols202604.</b> That one list has {fmt_int(largest['net_members'])} net members, or {fmt_pct(largest['net_members'] / total_net)} of the current net portfolio. That concentration is useful for reach but makes deliverability, queue safety, and unsubscribe hygiene disproportionately dependent on one asset."))
    story.append(bullet(f"<b>Delivery mechanics are mostly working, but the active queue needs attention.</b> The live queue snapshot shows {fmt_int(queue_status.get('succeeded'))} succeeded rows, no failed rows, only {fmt_int(queue_status.get('dead'))} dead rows, and {fmt_int(queue_status.get('pending'))} pending rows. The low dead count is good; the open pending and processing work is the immediate operational risk."))
    story.append(bullet(f"<b>Engagement tracking exists, but attribution is incomplete.</b> The provider event log contains delivered, opened, clicked, bounced, and delayed events, including {fmt_int(next((e['unique_recipients'] for e in data['provider_events']['by_type'] if e['event_type'] == 'opened'), 0))} unique recipients with opens and {fmt_int(next((e['unique_recipients'] for e in data['provider_events']['by_type'] if e['event_type'] == 'clicked'), 0))} unique recipients with clicks. Most stored events do not carry a campaign identifier, so performance can be read directionally but not yet as reliable per-campaign conversion."))

    story.append(PageBreak())
    story.append(p("The mailing list base is much bigger, but one list still carries the program", "Section"))
    story.append(p("The current list portfolio has eight lists. The new imports added meaningful segmentation, but Amols202604 remains the dominant reach engine. For planning, treat the new lists as segment-specific channels rather than a replacement for the main list.", "Body"))
    list_rows = sorted([(display_list_name(row["name"]), row["net_members"]) for row in lists], key=lambda item: item[1], reverse=True)
    story.append(HorizontalBarChart(
        "Net mailing list size by list",
        "Net size equals total stored members minus unsubscribed members.",
        list_rows,
        color=BLUE,
    ))
    story.append(Spacer(1, 0.10 * inch))
    story.append(p("The chart is intentionally scaled to show the imbalance. The key implication is operational: mistakes, deliverability issues, or quota limits on Amols202604 will dominate the overall program until the smaller lists either grow or are used for distinct high-value outreach.", "Small"))

    table_data = [["Mailing list", "Total size", "Unsubscribed", "Net size", "Unsubscribe rate"]]
    for row in lists:
        display = display_list_name(row["name"])
        table_data.append([display, fmt_int(row["total_members"]), fmt_int(row["unsubscribed_members"]), fmt_int(row["net_members"]), fmt_pct(row["unsubscribe_rate"], 2)])
    story.append(p("Full list inventory", "Subsection"))
    story.append(make_table(table_data, [2.48 * inch, 0.88 * inch, 0.92 * inch, 0.88 * inch, 1.08 * inch]))

    story.append(PageBreak())
    story.append(p("The new imports are clean enough to use, with different jobs", "Section"))
    story.append(p("The three new lists were created from Affinity exports dated June 5, 2026. The family office file is a broad reach asset. The high net worth friends file is small and personal. The Limited Partner Pipeline file creates multiple recipients from some opportunity rows, so its unique-address count is larger than the number of opportunity rows.", "Body"))
    import_rows = [(r["display_name"], r["csv_rows"], r["unique_emails"]) for r in imports]
    story.append(StackedBarChart(
        "Imported source rows and unique usable email addresses",
        "Shows how much usable recipient coverage each source file produced.",
        [
            {"label": label, "values": [("Source rows", csv_rows), ("Unique email addresses", unique)]}
            for label, csv_rows, unique in import_rows
        ],
        [("Source rows", NEUTRAL_LIGHT), ("Unique email addresses", BLUE)],
        height=2.2 * inch,
    ))
    story.append(Spacer(1, 0.10 * inch))
    import_table = [["Source list", "Rows in file", "Rows with a recipient", "Unique email addresses", "Duplicate email occurrences"]]
    for row in imports:
        import_table.append([
            row["display_name"],
            fmt_int(row["csv_rows"]),
            fmt_int(row["rows_with_recipient"]),
            fmt_int(row["unique_emails"]),
            fmt_int(row["duplicate_email_occurrences"]),
        ])
    story.append(make_table(import_table, [1.95 * inch, 0.78 * inch, 1.08 * inch, 1.10 * inch, 1.30 * inch]))
    story.append(p("<b>Interpretation.</b> The family office export had the largest amount of missing contact detail, but still produced 18,233 usable unique addresses. The Limited Partner Pipeline export has the most duplication because one opportunity can repeat people across relationships; deduplication kept the final list clean.", "Body"))

    new_lists = [list_by_name[name] for name in ["Family Offices 2026 06 05", "High Net Worth Amols Friends 2026 06 05", "LP Pipeline 2026 06 05"]]
    country_rows = []
    for row in new_lists:
        label = "Limited Partner Pipeline" if row["name"] == "LP Pipeline 2026 06 05" else row["name"].replace(" 2026 06 05", "")
        top = row.get("top_countries", [])[:4]
        country_rows.append([label, ", ".join(f"{c['name']} ({fmt_int(c['count'])})" for c in top) or "No country metadata available"])
    story.append(p("Geography coverage in the new lists", "Subsection"))
    story.append(make_table([["New list", "Largest country segments"]] + country_rows, [1.65 * inch, 4.60 * inch]))

    story.append(PageBreak())
    story.append(p("Recent sends show reach, but completion is uneven", "Section"))
    story.append(p("The recent mailing history has three distinct patterns: complete test or small-list sends, a large canceled send, and a large live LifeX send that still had pending and processing rows at the snapshot time. This is the most important operational readout because it says whether list capacity is turning into completed outreach.", "Body"))
    campaign_rows = []
    for campaign in campaigns:
        if campaign["list_name"] == "Amol's Test List":
            continue
        display = clean_label(campaign["label"], 44)
        campaign_rows.append({
            "label": f"{campaign['queued_at']}  {display}",
            "values": [
                ("Succeeded", campaign["counts"].get("succeeded") or 0),
                ("Pending or processing", (campaign["counts"].get("pending") or 0) + (campaign["counts"].get("processing") or 0)),
                ("Canceled", campaign["counts"].get("canceled") or 0),
                ("Dead", campaign["counts"].get("dead") or 0),
            ],
        })
    story.append(StackedBarChart(
        "Recent mailing outcome rows",
        "Each bar counts recipient-level queue rows for a mailing and list.",
        campaign_rows,
        [("Succeeded", OLIVE), ("Pending or processing", GOLD), ("Canceled", NEUTRAL), ("Dead", ORANGE)],
        height=3.25 * inch,
    ))
    story.append(Spacer(1, 0.10 * inch))
    story.append(p(f"<b>LifeX is the current focus.</b> The LifeX mailing on Amols202604 had {fmt_int(campaign_sent(current_lifex))} succeeded rows and {fmt_int(lifex_remaining)} rows still pending or processing at the snapshot. That means the send was about {fmt_pct(campaign_completion(current_lifex))} complete by recipient rows, excluding any unavailable canceled count for that one campaign.", "Body"))
    story.append(p("<b>The old May 7 send is correctly treated as a past incident, not a live campaign.</b> It sent 63,553 recipients before cancellation and left 122,592 canceled rows. The operational lesson is that large sends need explicit release windows, quota checks, and a scoped monitor before anyone opens a worker.", "Body"))

    recent_table = [["List", "Mailing", "Date", "Succeeded", "Pending or processing", "Canceled", "Dead"]]
    for campaign in campaigns:
        if campaign["list_name"] == "Amol's Test List" and campaign["queued_at"] != "2026-05-30":
            continue
        recent_table.append([
            campaign["list_name"],
            clean_label(campaign["label"], 34),
            parse_date(campaign["queued_at"]),
            fmt_int(campaign["counts"].get("succeeded")),
            fmt_int((campaign["counts"].get("pending") or 0) + (campaign["counts"].get("processing") or 0)),
            fmt_int(campaign["counts"].get("canceled")),
            fmt_int(campaign["counts"].get("dead")),
        ])
    story.append(make_table(recent_table, [1.04 * inch, 2.02 * inch, 0.86 * inch, 0.74 * inch, 1.00 * inch, 0.72 * inch, 0.56 * inch]))

    story.append(PageBreak())
    story.append(p("Latest mailing history by list", "Section"))
    story.append(p("This table keeps the operational lookup together: each mailing list, its current net size, and the latest three mailing records available from the queue history. Lists created today have no mailing history yet.", "Body"))
    history_rows = [["Mailing list", "Net size", "Latest mailing records"]]
    recent_by_list = data["recent_mailings_by_list"]
    for row in lists:
        recent = recent_by_list.get(row["name"], [])
        if recent:
            mailing_text = "<br/>".join(
                f"{parse_date(item['queued_at'])}: {clean_label(item['label'], 52)} "
                f"({fmt_int(item['counts'].get('succeeded'))} succeeded, "
                f"{fmt_int((item['counts'].get('pending') or 0) + (item['counts'].get('processing') or 0))} pending or processing)"
                for item in recent
            )
        else:
            mailing_text = "No queued or sent mailings found."
        history_rows.append([display_list_name(row["name"]), fmt_int(row["net_members"]), mailing_text])
    story.append(make_table(history_rows, [1.62 * inch, 0.74 * inch, 3.88 * inch]))

    story.append(PageBreak())
    story.append(p("The delivery system is successful at the row level, but queue hygiene is the blocker", "Section"))
    story.append(p("Across the queue, failures are not the main problem. The system has no failed rows in the snapshot and only three dead rows. The main issue is unresolved work: pending and processing rows that still need to be deliberately drained, held, or canceled.", "Body"))
    queue_rows = [
        ("Succeeded", queue_status.get("succeeded") or 0),
        ("Canceled", queue_status.get("canceled") or 0),
        ("Pending", queue_status.get("pending") or 0),
        ("Processing", queue_status.get("processing") or 0),
        ("Dead", queue_status.get("dead") or 0),
        ("Failed", queue_status.get("failed") or 0),
    ]
    story.append(HorizontalBarChart(
        "Current queue status",
        "Point-in-time count of recipient-level queue rows.",
        queue_rows,
        color=ORANGE,
        height=3.0 * inch,
    ))
    story.append(Spacer(1, 0.10 * inch))
    story.append(p("<b>Operational implication.</b> The sender can work, but it needs a controlled run book. Before any new campaign goes out, the current pending rows should be reconciled against the intended campaign identifier, Amazon Simple Email Service quota headroom, and list scope. This is especially important because the queue was changing during this report snapshot.", "Body"))

    story.append(PageBreak())
    story.append(p("Engagement exists, but campaign attribution needs repair", "Section"))
    story.append(p("The provider event log shows recipients receiving, opening, and clicking. That is encouraging because the system is capturing downstream behavior. However, most provider events lack an email identifier, so the data cannot yet answer which specific campaign, subject, or list is driving engagement.", "Body"))
    event_order = ["sent", "delivered", "opened", "clicked", "bounced", "deliverydelay"]
    event_map = {row["event_type"]: row for row in data["provider_events"]["by_type"]}
    funnel_rows = [(name.title().replace("Deliverydelay", "Delivery delayed"), event_map.get(name, {}).get("unique_recipients", 0)) for name in event_order if name in event_map]
    story.append(FunnelChart(
        "Provider events by unique recipient",
        "Overall event log only; most events cannot be tied back to a campaign.",
        funnel_rows,
    ))
    story.append(Spacer(1, 0.10 * inch))
    event_table = [["Event type", "Events", "Unique recipients", "What it tells you"]]
    event_meaning = {
        "sent": "Provider accepted the message event.",
        "delivered": "Mailbox provider reported delivery.",
        "opened": "Recipient loaded tracking content.",
        "clicked": "Recipient clicked a tracked link.",
        "bounced": "Mailbox rejected or could not accept delivery.",
        "deliverydelay": "Provider reported a temporary delay.",
    }
    for name in event_order:
        if name not in event_map:
            continue
        row = event_map[name]
        label = "Delivery delayed" if name == "deliverydelay" else name.title()
        event_table.append([label, fmt_int(row["count"]), fmt_int(row["unique_recipients"]), event_meaning.get(name, "")])
    story.append(make_table(event_table, [1.05 * inch, 0.70 * inch, 0.95 * inch, 3.55 * inch]))
    story.append(p("<b>Interpretation.</b> Click behavior is concentrated: 146 click events came from 30 unique recipients. That suggests some recipients are highly engaged, but without campaign identifiers the next best action is instrumentation repair, not over-interpreting the click rate.", "Body"))

    story.append(PageBreak())
    story.append(p("What this says about what you have been doing", "Section"))
    story.append(p("<b>You have moved from one broad personal list toward a segmented fundraising and investor-relations system.</b> The new list names map to different jobs: family offices for institutional wealth reach, high net worth friends for warmer personal outreach, and Limited Partner Pipeline for active fundraising follow-up.", "Body"))
    story.append(p("<b>The mailing operation is becoming scale-constrained rather than list-constrained.</b> You now have more than enough addresses to hit daily sending limits. The limiting factors are queue control, Amazon Simple Email Service quota, campaign attribution, and whether the right segment receives the right message at the right time.", "Body"))
    story.append(p("<b>The healthiest behavior so far is low hard failure.</b> Dead and failed queue rows are tiny relative to succeeded sends. The riskiest behavior is unresolved queue state after large releases, because it blurs whether a campaign is still in progress, intentionally held, or accidentally active.", "Body"))

    story.append(p("Recommended next steps", "Section"))
    story.append(bullet("<b>Finish or intentionally hold the LifeX queue before starting a new large send.</b> Use only the explicit campaign identifier and verify pending, processing, and quota headroom first."))
    story.append(bullet("<b>Use the new lists as separate campaigns, not one merged blast.</b> Family offices, high net worth friends, and Limited Partner Pipeline contacts should get different framing, reply paths, and follow-up expectations."))
    story.append(bullet("<b>Repair provider event attribution.</b> Make sure each provider event stores the campaign identifier or a reliable message-to-campaign mapping. Without that, opens and clicks cannot guide subject lines, audience selection, or follow-up priority."))
    story.append(bullet("<b>Add a list-health review before each send.</b> Review net size, unsubscribed count, top domains, recent send history, and duplicate or recently contacted recipients before queue release."))
    story.append(bullet("<b>Create a simple weekly operating report.</b> Track net list size, newly added addresses, sent rows, pending rows, dead rows, bounces, opens, clicks, and unsubscribes. The most useful trend will be movement week over week, not a one-time table."))

    story.append(p("Further questions", "Section"))
    story.append(bullet("Which segment produces the most replies, meetings, or commitments after email, not just clicks? That needs reply or customer relationship management data joined to mailing history."))
    story.append(bullet("Should the family office list be warmed gradually before a full campaign? The list is large enough that a poor first message could create avoidable unsubscribes or reputation pressure."))
    story.append(bullet("Are pending rows intended to be sent, held for quota pacing, or canceled? The answer changes whether the current system is healthy or stuck."))
    story.append(bullet("Which contacts overlap across the new lists and Amols202604? This report deduplicates inside each new list, but cross-list overlap should be checked before sending similar messages."))

    story.append(PageBreak())
    story.append(p("Caveats, assumptions, and evidence notes", "Section"))
    story.append(p("The report uses the live Supabase project as the database source and the three June 5, 2026 Affinity exports as the import source. The local evidence bundle is saved next to this report as report-data.json.", "Body"))
    story.append(bullet("The queue snapshot is point-in-time. Counts changed during live reads, so active queue numbers should be refreshed immediately before operational decisions."))
    story.append(bullet("Provider event counts are directional because most stored events do not contain a campaign identifier. They prove that tracking exists, but they do not prove campaign-level performance."))
    story.append(bullet("The old May 7 large campaign's succeeded count uses the checked-in operator status because the live exact-count query timed out for that status."))
    story.append(bullet("Net size is defined here as total stored members minus unsubscribed members. It does not remove bounced addresses unless those addresses were also marked unsubscribed."))
    story.append(bullet("The source files are Affinity exports. The report preserves their mailing list names, but expands Limited Partner in prose for readability."))

    doc.build(story, canvasmaker=NumberedCanvas)
    return OUT_PATH


if __name__ == "__main__":
    print(build())
