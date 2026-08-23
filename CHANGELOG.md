# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [1.1.1]

### Changed
- Mobile layout is less cramped: the main container now fills the screen edge-to-edge on mobile (no card background, border, rounded corners, or shadow), with that styling still applied from `md` breakpoints up. Outer and inner padding on mobile is halved.
- The growth chart remains a permanent fixture at the top of the page. Below it, the weight tools (Prediction Settings / Add Measurement / History) and milestone tools (Add Milestone / History) are now grouped into a single bordered container with a "Weight" / "Milestones" tab strip attached to its header, so only one group is visible at a time instead of both stacking vertically. These top-level tabs use a flat, underlined style, visually distinct from the pill-shaped sub-tabs inside each panel.
- Reduced outer and inner container padding further for a more compact layout.
- On mobile, the growth chart now spans the same width as the title and other containers (no extra side padding), and its X-axis ticks are now aligned to calendar months instead of a mash of irregular data-point dates.

## [1.1.0]

### Added
- Developmental milestones feature:
  - New `milestones` table and `GET/POST/PUT/DELETE /api/milestones` endpoints for logging a milestone `date` and free-text `description`.
  - "Add Milestone" and "History" tabs for adding, editing, and deleting milestones (mirrors the existing measurement add/edit/delete UX).
  - Milestones are plotted on the growth chart as a vertical marker line with a star icon at the top; hovering the star shows the milestone's date and description.
  - The chart's visible date range now extends automatically to include the latest logged milestone, so a milestone logged after the most recent weight entry is never hidden off the edge of the graph.
- Tabbed containers on the main page: growth tracking (Prediction Settings / Add Measurement / History) and milestones (Add Milestone / History) are now switchable tab groups instead of stacked sections, keeping the chart's position unchanged.

## [1.0.0]

_Baseline captured retroactively when this changelog was introduced._

### Added
- Initial release of Sprog Log, a baby weight tracker with WHO growth centiles.
- Onboarding flow to set up a child profile (name, birth date, sex), editable later via a settings modal.
- Weight measurement logging with add, edit, and delete support, backed by a Postgres `measurements` table and `GET/POST/PUT/DELETE /api/measurements` endpoints.
- Growth chart (Recharts) plotting logged weight against UK-WHO percentile bands (2nd-98th), with exact centile calculation via WHO LMS parameters.
- Configurable growth prediction: a linear trendline computed from a user-selected window of recent entries, projected forward by a user-selected number of weeks.
- Measurement History list showing weight in grams, lb/oz, and exact centile per entry.
- JSON export/import of profile and measurement data.
