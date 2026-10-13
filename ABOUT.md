# evacsim

**A flood evacuation planner for New Jersey's 12th Congressional District.**

## What it is

evacsim is a live, interactive map that shows what happens when everyone living in NJ-12's flood zones tries to drive out at once. You press Run and watch thousands of cars leave their homes, fill the roads, back up at bottlenecks, and reach dry ground (or fail to).

It doesn't just show the problem. It lets you build an evacuation plan, test it, and compare it against other plans to see which one gets people out fastest.

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

During a flood, roads become the problem. Bridges go under water, low streets close, and everyone heads for the same few highways. A plan that looks fine on paper can turn into hours-long gridlock.

Evacuation plans are usually written as documents and rarely tested. evacsim turns them into something you can run and watch, so the weak spots show up on a screen first instead of during the next storm.

## What you can do with it

- **Watch an evacuation play out** and see how long it takes to get everyone out, which roads jam first, and which towns get stuck the longest.
- **Close roads and bridges**, either right away or at a set time (like "this bridge floods 30 minutes in"), to check whether the plan still works when a key route is lost. Roads can also be narrowed or widened, like a lane closure or extra lanes opened by police.
- **Schedule evacuation orders town by town** instead of telling everyone to leave at once, so neighboring towns don't all hit the same bottleneck together.
- **Stagger by risk** with one click: towns with the most households without cars are told to leave first, and the rest follow in waves.
- **Change who leaves**: how many people in each town actually follow the order, and how many neighbors outside the flood zone leave too.
- **Save and compare plans** side by side (time to get 90% of people out, total delay, people stranded), then export the results as a spreadsheet or print them.

## Who it's for

- **Local emergency managers and town officials** writing and testing evacuation plans and deciding when to issue orders
- **Residents** who want to understand their own flood risk and how they'd get out
- **Policymakers**, including our representative, who can see where road and bridge upgrades would save the most time

## The point

Floods in New Jersey are getting worse and more frequent. evacsim gives the people in charge a way to try out a plan before a storm instead of during one, and to prove with numbers which plan works best.
