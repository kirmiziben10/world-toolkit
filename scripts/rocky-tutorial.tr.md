# Rocky'nın Eğitimi

<!-- tutorial: onboarding -->

## Adım 0: Tanışma
<!-- wait: delay 10 -->
> {color:cyan}Merhaba!{/color} Ben {bold}Rocky{/bold}, arazi arkadaşın! {shake}Tanıştığıma memnun oldum!{/shake} Dünyanın en güzel noktalarını keşfetmende sana yardım edeceğim!

## Adım 1: Program seç
<!-- target: #desktop-icons -->
<!-- wait: branch -->
<!-- branch: click #icon-search-spots search -->
<!-- branch: click #icon-radio-reach radio -->
<!-- arm: right -->
> Önce hangi uygulamayı öğrenmek istersin? {bold}Nokta Ara{/bold} dağ manzaralı seyir noktaları buluyor, {bold}Radyo Menzili{/bold} ise radyo sinyal kapsama alanını haritalıyor. {color:green}Bir ikona tıkla{/color} ve seç!

<!-- timeout: 15 -->
> Başlamak için {bold}Nokta Ara{/bold} ya da {bold}Radyo Menzili{/bold}'ne tıkla!

<!-- timeout: 30 -->
> Hadi birini seç! Eğitimi daha sonra istediğin zaman tekrar edebilirsin!

<!-- timeout: 50 -->
> {shake}Gerekirse bütün gün beklerim!{/shake}

## Adım 2: Dikdörtgen çiz
<!-- branch-only: search -->
<!-- target: .leaflet-draw-draw-rectangle -->
<!-- target-mobile: .leaflet-draw-draw-rectangle -->
<!-- wait: custom wt:rectangle-drawn -->
<!-- arm: right -->
> Şimdi bu araca tıkla ve haritada bir {bold}dikdörtgen sürükle{/bold}!

<!-- timeout: 15 -->
> Dikdörtgen aracına tıkla, ardından bir alan seçmek için haritada sürükle.

<!-- timeout: 30 -->
> Herhangi bir yere bir dikdörtgen çizmen yeterli — daha sonra her zaman baştan yapabilirsin!

## Adım 3: Analiz et
<!-- branch-only: search -->
<!-- mobile-only: true -->
<!-- target-mobile: #controls-toggle -->
<!-- wait: click #controls-toggle -->
<!-- arm: left -->
> {bold}Mobilde{/bold}, önce filtre panelini aç ki Analiz Et düğmesine rahatça ulaşabilesin.

<!-- timeout: 12 -->
> Filtreleri dışarı kaydırmak için bu oka dokun.

## Adım 4: Analiz et
<!-- branch-only: search -->
<!-- target: #analyze-btn -->
<!-- target-mobile: #analyze-btn -->
<!-- wait: click #analyze-btn -->
<!-- arm: left -->
> {bold}Analiz Et{/bold}'e tıkla, ben en iyi manzaraları bulayım!

<!-- timeout: 10 -->
> Şuradaki büyük düğme — ona bir kez tıkla!

## Adım 5: Sonuçları gör
<!-- branch-only: search -->
<!-- target: .result-card -->
<!-- target-mobile: .result-card -->
<!-- wait: visible .result-card -->
<!-- arm: right -->
> {rainbow}Güzel!{/rainbow} Bunlar senin manzara noktaların! Haritada görmek için herhangi bir karta tıkla!

## Adım 6: Filtreleri kapat
<!-- branch-only: search -->
<!-- mobile-only: true -->
<!-- target-mobile: #controls-toggle -->
<!-- wait: click #controls-toggle -->
<!-- arm: left -->
> Son bir mobil ipucu: sonuçlara daha rahat bakmak için bu oka tekrar dokun ve {bold}filtreleri kapat{/bold}.

<!-- timeout: 12 -->
> Paneli geri gizle ki harita ve sonuç listesi daha geniş görünsün.

## Adım 7: Radyo Menzili yer tutucu
<!-- branch-only: radio -->
<!-- wait: delay 10 -->
> {bold}Radyo Menzili{/bold} eğitimi yakında geliyor! Şimdilik kendi başına keşfet — {color:green}haritaya tıkla{/color} ve bir verici yerleştir, ayarları yap ve {bold}Analiz Et{/bold}'e bas!
