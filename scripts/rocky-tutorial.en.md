# Rocky's Tutorial

<!-- tutorial: onboarding -->

## Step 0: Introduction
<!-- wait: delay 10 -->
> {color:cyan}Hey there!{/color} I'm {bold}Rocky{/bold}, your terrain buddy! {shake}Nice to meet you!{/shake} I'll be here to help you explore and find the best spots on Earth!

## Step 1: Choose a program
<!-- target: #desktop-icons -->
<!-- wait: branch -->
<!-- branch: click #icon-search-spots search -->
<!-- branch: click #icon-radio-reach radio -->
<!-- arm: right -->
> Which app would you like to learn first? {bold}Search for Spots{/bold} finds scenic mountain viewpoints, and {bold}Radio Range{/bold} maps radio signal coverage. {color:green}Click an icon{/color} to choose!

<!-- timeout: 15 -->
> Click {bold}Search for Spots{/bold} or {bold}Radio Range{/bold} to get started!

<!-- timeout: 30 -->
> Go ahead, pick one! You can always replay the tutorial later!

<!-- timeout: 50 -->
> {shake}I'll wait all day if I have to!{/shake}

## Step 2: Draw a rectangle
<!-- branch-only: search -->
<!-- target: .leaflet-draw-draw-rectangle -->
<!-- target-mobile: .leaflet-draw-draw-rectangle -->
<!-- wait: custom wt:rectangle-drawn -->
<!-- arm: right -->
> Now click this tool and {bold}drag a rectangle{/bold} on the map!

<!-- timeout: 15 -->
> Click the rectangle tool, then drag on the map to select an area.

<!-- timeout: 30 -->
> Just draw a rectangle anywhere — you can always redo it!

## Step 3: Analyze
<!-- branch-only: search -->
<!-- mobile-only: true -->
<!-- target-mobile: #controls-toggle -->
<!-- wait: click #controls-toggle -->
<!-- arm: left -->
> On {bold}mobile{/bold}, open the filters panel first so you can reach the Analyze button easily.

<!-- timeout: 12 -->
> Tap this arrow to slide the filters out.

## Step 4: Analyze
<!-- branch-only: search -->
<!-- target: #analyze-btn -->
<!-- target-mobile: #analyze-btn -->
<!-- wait: click #analyze-btn -->
<!-- arm: left -->
> Hit {bold}Analyze{/bold} and I'll find the best viewpoints!

<!-- timeout: 10 -->
> That big button right there — give it a click!

## Step 5: Check results
<!-- branch-only: search -->
<!-- target: .result-card -->
<!-- target-mobile: .result-card -->
<!-- wait: visible .result-card -->
<!-- arm: right -->
> {rainbow}Nice!{/rainbow} These are your viewpoints! Click any card to see it on the map!

## Step 6: Close filters
<!-- branch-only: search -->
<!-- mobile-only: true -->
<!-- target-mobile: #controls-toggle -->
<!-- wait: click #controls-toggle -->
<!-- arm: left -->
> One more mobile tip: tap this arrow again to {bold}close the filters{/bold} and give the results more room.

<!-- timeout: 12 -->
> Tuck the panel away so the map and result list have more space.

## Step 7: Radio Range placeholder
<!-- branch-only: radio -->
<!-- wait: delay 10 -->
> The {bold}Radio Range{/bold} tutorial is coming soon! For now, feel free to explore on your own — {color:green}click the map{/color} to place a transmitter, adjust the settings, and hit {bold}Analyze{/bold}!
