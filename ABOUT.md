# evacsim

**A flood evacuation planner for New Jersey's 12th Congressional District.**

## What it is

evacsim is an interactive model of cars leaving NJ-12's mapped flood zones. You press Run and watch simulated traffic move through the road network, queue at bottlenecks, and reach modeled exits or become stranded.

It lets you build scenarios and compare their modeled travel times, queue delays, and stranded cars. It has not been calibrated against an observed evacuation and is not an operational forecast. The app's [methodology page](public/methodology.html) explains the assumptions, sources, and limitations.

It covers 32 towns, including Trenton, Princeton, Ewing, Plainfield, Bound Brook, Manville, East Brunswick and Franklin. It uses real data: the actual road network, FEMA's official flood maps, and Census counts of who lives where and who owns a car.

## What it evacuates

The people who live inside FEMA's **100-year floodplain** in NJ-12:

- about **50,000 people** in **17,600 households**
- about **1,400 of those households (3,900 people) have no car** and can't drive themselves out

It also models **neighbors just outside the flood zone** (about 75,000 more households) who often leave anyway, even when they aren't told to. This is called "shadow evacuation." These extra cars crowd the same roads and slow down the people who actually need to get out.

## What disasters it's for

Flooding. NJ-12 sits along the Raritan, Millstone, Delaware and Assunpink rivers and many smaller streams, and those flood again and again. Hurricane Ida (2021) flooded Manville, Bound Brook and other towns in the district with almost no warning.

The simulator handles three levels of warning:

- **Sudden**: a flash flood or overnight surge. Almost no time to react.
- **Short**: a few hours of warning.
- **Long**: an evacuation order issued the day before.

## Why it exists

Road closures and competing traffic can change which evacuation routes remain available. evacsim explores these effects under explicit assumptions about departures and road capacity. Its default scenario does not show hours-long gridlock.

The aim is to make those assumptions and tradeoffs visible so people can ask better questions about a plan before a storm.

## What you can do with it

- **Watch an evacuation play out** and see how long it takes to get everyone out, which roads jam first, and which towns get stuck the longest.
- **Close roads and bridge segments**, either right away or at a set time, to test hypothetical route losses. The crossing preset selects bridges intersecting mapped flood zones; it does not establish that their decks flood. Road discharge capacity can also be changed.
- **Schedule evacuation orders town by town** instead of telling everyone to leave at once, so neighboring towns don't all hit the same bottleneck together.
- **Stagger towns** with one click: towns with the most households without cars receive orders first, and the rest follow in waves. Their assisted transport is not modeled, and staggering is not guaranteed to improve outcomes.
- **Follow a guided experiment** comparing open roads, hypothetical crossing closures after 30 minutes, and staggered orders. All three results are calculated in the browser; the comparison shows tradeoffs rather than assuming one plan wins.
- **Change who leaves**: how many people in each town actually follow the order, and how many neighbors outside the flood zone leave too.
- **Save and compare plans** side by side (time to get 90% of people out, total delay, people stranded), then export the results as a spreadsheet or print them.

## Who it's for

- **Local emergency managers and town officials** writing and testing evacuation plans and deciding when to issue orders
- **Residents** who want to understand their own flood risk and how they'd get out
- **Policymakers**, including our representative, who can see where road and bridge upgrades would save the most time

## The point

evacsim provides an accessible way to explore evacuation scenarios. Its results are starting points for discussion and further validation, not proof that a plan will work in a real flood.
