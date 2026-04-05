/**
 * i18n.js
 * Lightweight internationalization module for World Toolkit.
 * Uses localStorage('sv_buddy_lang') as language source (shared with Rocky).
 *
 * Usage:
 *   t('analyzeArea')          → translated string
 *   t('tileCount', {n:5, max:80}) → template with {{n}}, {{max}} replaced
 *   translatePage()           → updates all [data-i18n] elements in DOM
 */
(function () {
  'use strict';

  var strings = {
    en: {
      // Desktop icons
      searchForSpots: 'Search for Spots',
      starredSpots: 'Starred Spots',
      lovedSpots: 'Loved Spots',
      rocky: 'Rocky',

      // Search bar
      searchPlaceholder: 'Search ',

      // Window titles
      searchForSpotsTitle: 'Search For Spots',
      lovedSpotsTitle: 'Loved Spots',
      starredSpotsTitle: 'Starred Spots',

      // Window buttons
      help: 'Help',
      maximize: 'Maximize',
      restore: 'Restore',
      close: 'Close',
      toggleFilters: 'Toggle filters',

      // Controls panel
      viewpointCriteria: 'Viewpoint Criteria',
      minimumElevation: 'Minimum Elevation',
      maxSlope: 'Max Slope',
      scenery: 'Scenery',
      closeness: 'Closeness',
      valleyDepth: 'Valley depth',
      minPeakProminence: 'Min Peak Prominence',

      // Buttons
      undo: '↶ Undo',
      redo: '↷ Redo',
      undoTooltip: 'Undo (Ctrl+Z)',
      redoTooltip: 'Redo (Ctrl+Shift+Z)',
      analyzeArea: 'Analyze Area',
      clearResults: 'Clear Results',
      areaTooLarge: 'Area too large ({{n}} tiles, max {{max}})',

      // Results panel
      viewpoints: 'Viewpoints',

      // Help tooltip
      helpTitle: 'How to use this window',
      helpStep1: 'Draw a selection: click the rectangle icon in the map toolbar (top-right) and drag to mark an area.',
      helpStep2: 'Set criteria: use the sliders to control minimum elevation, max slope, peak closeness, valley depth, and peak prominence.',
      helpStep3: 'Click "Analyze Area" — terrain data is fetched and analyzed entirely in your browser.',
      helpStep4: 'Explore results: directional markers show viewpoints on the map. Click a marker or result card for details.',
      helpStep5: 'Save favourites: use ❤️ Love or ⭐ Star buttons to bookmark spots across sessions.',

      // Empty states
      noLovedYet: '❤️ No loved spots yet.',
      noStarredYet: '⭐ No starred spots yet.',
      emptyHint: 'Run an analysis and heart/star spots you like!',
      lovedPrevSession: 'Your loved spots are from a previous session.',
      starredPrevSession: 'Your starred spots are from a previous session.',
      reanalyzeHint: 'Re-analyze the area to see them on the map.',

      // No results
      noResults: 'No viewpoints matched your criteria. Try adjusting the filters or selecting a different area.',

      // Progress
      startingAnalysis: 'Starting analysis...',
      analyzingTerrain: 'Analyzing Terrain',
      preparing: 'Preparing...',
      fetchingTiles: 'Fetching elevation tiles...',
      decodingElevation: 'Decoding elevation data...',
      tileProgress: '{{loaded}} / {{total}} tiles',

      // Errors
      analysisFailed: 'Analysis failed: ',

      // Result card labels
      elev: 'Elev',
      slope: 'Slope',
      peak: 'Peak',
      valley: 'Valley',
      viewDirection: 'View direction',

      // Popup labels
      viewpointTitle: 'Viewpoint #{{n}} — Score: {{score}}',
      viewDirectionLabel: 'View Direction:',
      elevation: 'Elevation',
      slopeLabel: 'Slope',
      nearestPeak: 'Nearest Peak',
      valleyDepthLabel: 'Valley Depth',
      peakDistance: 'Peak Distance',
      prominence: 'Prominence',

      // Action buttons
      love: 'Love',
      star: 'Star',
      maps: 'Maps',
      scene3d: '3D Scene',
      loveThisSpot: 'Love this spot',
      starThisSpot: 'Star this spot',
      getDirections: 'Get Directions to Spot',
      scenic3dView: 'Scenic 3D View (No Pin)',

      // Cluster
      clusterViews: '{{n}} views',

      // Map layers
      layerStandard: 'Standard',
      layerTopographic: 'Topographic',
      layerWorldTopo: 'World Topo (Esri)',
      layerSatellite: 'Satellite',

      // Compass
      compass: ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'],

      // Worker progress
      workerSlope: 'Computing slope map...',
      workerPeaks: 'Finding mountain peaks...',
      workerFoundPeaks: 'Found {{n}} peaks',
      workerProminence: 'Prominence ≥ {{min}}m',
      workerSearching: 'Searching for scenic viewpoints...',
      workerCandidates: 'Found {{n}} candidates',
      workerClustering: 'Clustering nearby results...',
      workerDone: 'Done!',
      workerResultCount: '{{n}} viewpoints found',
      workerScanning: 'Scanning for viewpoints...',
      workerScanRow: 'Row {{y}} / {{h}}',

      // Idle tips (buddy-integration.js)
      tipZoom: '{color:cyan}Pro tip:{/color} Zoom in closer on the map for {bold}more precise{/bold} viewpoint locations!',
      tipValley: 'Did you know? {bold}Valley depth{/bold} is the single most important factor in the {rainbow}scenic score{/rainbow}!',
      tipCamping: '{color:green}Camping tip:{/color} Look for spots with slopes under {bold}10 degrees{/bold} — your back will thank you!',
      tipGlobe: 'The {bold}globe{/bold} on the left is interactive! Spin it to explore {rainbow}the world{/rainbow}!',
      tipTerrain: '{shake}Fun fact:{/shake} The terrain data comes from open elevation tiles at {bold}~58m resolution{/bold}!',
      tipCloseness: 'Try using the {color:cyan}Closeness{/color} slider to find viewpoints {bold}nearer{/bold} to dramatic peaks!',
      tipProminence: '{bold}Peak prominence{/bold} measures how much a mountain stands out — higher is more {rainbow}dramatic{/rainbow}!',

      // Tutorial complete
      tutorialComplete: '{rainbow}Tutorial complete!{/rainbow} You\'re ready to find amazing viewpoints!',
    },

    tr: {
      // Desktop icons
      searchForSpots: 'Nokta Ara',
      starredSpots: 'Yıldızlı Noktalar',
      lovedSpots: 'Beğenilen Noktalar',
      rocky: 'Rocky',

      // Search bar
      searchPlaceholder: 'Ara ',

      // Window titles
      searchForSpotsTitle: 'Nokta Ara',
      lovedSpotsTitle: 'Beğenilen Noktalar',
      starredSpotsTitle: 'Yıldızlı Noktalar',

      // Window buttons
      help: 'Yardım',
      maximize: 'Büyüt',
      restore: 'Geri Al',
      close: 'Kapat',
      toggleFilters: 'Filtreleri aç/kapa',

      // Controls panel
      viewpointCriteria: 'Manzara Noktası Kriterleri',
      minimumElevation: 'Minimum Yükseklik',
      maxSlope: 'Maks Eğim',
      scenery: 'Manzara',
      closeness: 'Yakınlık',
      valleyDepth: 'Vadi derinliği',
      minPeakProminence: 'Min Zirve Belirginliği',

      // Buttons
      undo: '↶ Geri Al',
      redo: '↷ Yinele',
      undoTooltip: 'Geri Al (Ctrl+Z)',
      redoTooltip: 'Yinele (Ctrl+Shift+Z)',
      analyzeArea: 'Alanı Analiz Et',
      clearResults: 'Sonuçları Temizle',
      areaTooLarge: 'Alan çok büyük ({{n}} karo, maks {{max}})',

      // Results panel
      viewpoints: 'Manzara Noktaları',

      // Help tooltip
      helpTitle: 'Bu pencere nasıl kullanılır',
      helpStep1: 'Bir alan seçin: harita araç çubuğundaki (sağ üst) dikdörtgen simgesine tıklayın ve sürükleyerek bir alan belirleyin.',
      helpStep2: 'Kriterleri ayarlayın: minimum yükseklik, maks eğim, zirve yakınlığı, vadi derinliği ve zirve belirginliğini kaydırıcılarla kontrol edin.',
      helpStep3: '"Alanı Analiz Et"e tıklayın — arazi verileri tamamen tarayıcınızda indirilir ve analiz edilir.',
      helpStep4: 'Sonuçları keşfedin: yönlü işaretçiler haritadaki manzara noktalarını gösterir. Ayrıntılar için bir işaretçiye veya sonuç kartına tıklayın.',
      helpStep5: 'Favorileri kaydedin: oturumlar arasında noktaları kaydetmek için ❤️ Beğen veya ⭐ Yıldızla düğmelerini kullanın.',

      // Empty states
      noLovedYet: '❤️ Henüz beğenilen nokta yok.',
      noStarredYet: '⭐ Henüz yıldızlı nokta yok.',
      emptyHint: 'Bir analiz çalıştırın ve beğendiğiniz noktaları işaretleyin!',
      lovedPrevSession: 'Beğendiğiniz noktalar önceki bir oturumdan.',
      starredPrevSession: 'Yıldızlı noktalarınız önceki bir oturumdan.',
      reanalyzeHint: 'Haritada görmek için alanı tekrar analiz edin.',

      // No results
      noResults: 'Kriterlerinize uyan manzara noktası bulunamadı. Filtreleri ayarlamayı veya farklı bir alan seçmeyi deneyin.',

      // Progress
      startingAnalysis: 'Analiz başlatılıyor...',
      analyzingTerrain: 'Arazi Analiz Ediliyor',
      preparing: 'Hazırlanıyor...',
      fetchingTiles: 'Yükseklik karoları indiriliyor...',
      decodingElevation: 'Yükseklik verileri çözümleniyor...',
      tileProgress: '{{loaded}} / {{total}} karo',

      // Errors
      analysisFailed: 'Analiz başarısız: ',

      // Result card labels
      elev: 'Yük',
      slope: 'Eğim',
      peak: 'Zirve',
      valley: 'Vadi',
      viewDirection: 'Bakış yönü',

      // Popup labels
      viewpointTitle: 'Manzara Noktası #{{n}} — Puan: {{score}}',
      viewDirectionLabel: 'Bakış Yönü:',
      elevation: 'Yükseklik',
      slopeLabel: 'Eğim',
      nearestPeak: 'En Yakın Zirve',
      valleyDepthLabel: 'Vadi Derinliği',
      peakDistance: 'Zirve Mesafesi',
      prominence: 'Belirginlik',

      // Action buttons
      love: 'Beğen',
      star: 'Yıldızla',
      maps: 'Harita',
      scene3d: '3B Sahne',
      loveThisSpot: 'Bu noktayı beğen',
      starThisSpot: 'Bu noktayı yıldızla',
      getDirections: 'Noktaya Yol Tarifi Al',
      scenic3dView: 'Manzaralı 3B Görünüm',

      // Cluster
      clusterViews: '{{n}} nokta',

      // Map layers
      layerStandard: 'Standart',
      layerTopographic: 'Topografik',
      layerWorldTopo: 'Dünya Topo (Esri)',
      layerSatellite: 'Uydu',

      // Compass
      compass: ['K','KKD','KD','DKD','D','DGD','GD','GGD','G','GGB','GB','BGB','B','BKB','KB','KKB'],

      // Worker progress
      workerSlope: 'Eğim haritası hesaplanıyor...',
      workerPeaks: 'Dağ zirveleri bulunuyor...',
      workerFoundPeaks: '{{n}} zirve bulundu',
      workerProminence: 'Belirginlik ≥ {{min}}m',
      workerSearching: 'Manzaralı noktalar aranıyor...',
      workerCandidates: '{{n}} aday bulundu',
      workerClustering: 'Yakın sonuçlar gruplanıyor...',
      workerDone: 'Tamamlandı!',
      workerResultCount: '{{n}} manzara noktası bulundu',
      workerScanning: 'Manzara noktaları taranıyor...',
      workerScanRow: 'Satır {{y}} / {{h}}',

      // Idle tips (buddy-integration.js)
      tipZoom: '{color:cyan}İpucu:{/color} Daha {bold}kesin{/bold} manzara noktaları için haritayı yakınlaştırın!',
      tipValley: 'Biliyor muydunuz? {bold}Vadi derinliği{/bold} {rainbow}manzara puanının{/rainbow} en önemli faktörüdür!',
      tipCamping: '{color:green}Kamp ipucu:{/color} {bold}10 derecenin{/bold} altında eğimli noktalar arayın — sırtınız size teşekkür edecek!',
      tipGlobe: 'Soldaki {bold}küre{/bold} etkileşimli! {rainbow}Dünyayı{/rainbow} keşfetmek için döndürün!',
      tipTerrain: '{shake}İlginç bilgi:{/shake} Arazi verileri {bold}~58m çözünürlükte{/bold} açık yükseklik karolarından geliyor!',
      tipCloseness: '{color:cyan}Yakınlık{/color} kaydırıcısını kullanarak dramatik zirvelere {bold}daha yakın{/bold} noktalar bulun!',
      tipProminence: '{bold}Zirve belirginliği{/bold} bir dağın ne kadar öne çıktığını ölçer — yüksek değer daha {rainbow}etkileyici{/rainbow} demektir!',

      // Tutorial complete
      tutorialComplete: '{rainbow}Eğitim tamamlandı!{/rainbow} Muhteşem manzara noktaları bulmaya hazırsın!',
    },
  };

  function getLang() {
    if (window.getCurrentLang) return window.getCurrentLang();
    var lang = localStorage.getItem('sv_buddy_lang');
    if (!lang && navigator.language) lang = navigator.language.split('-')[0];
    return lang === 'tr' ? 'tr' : 'en';
  }

  function t(key, params) {
    var lang = getLang();
    var s = (strings[lang] && strings[lang][key]) || strings.en[key] || key;
    if (params) {
      Object.keys(params).forEach(function (k) {
        s = s.replace(new RegExp('\\{\\{' + k + '\\}\\}', 'g'), params[k]);
      });
    }
    return s;
  }

  /**
   * Update all DOM elements with [data-i18n] attribute.
   * data-i18n="key"              → sets textContent
   * data-i18n-attr="title:key"   → sets attribute
   * data-i18n-placeholder="key"  → sets placeholder
   */
  function translatePage() {
    var els = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var key = el.getAttribute('data-i18n');
      if (key) el.textContent = t(key);
    }

    var attrEls = document.querySelectorAll('[data-i18n-attr]');
    for (var j = 0; j < attrEls.length; j++) {
      var el = attrEls[j];
      var parts = el.getAttribute('data-i18n-attr').split(/\s*,\s*/);
      for (var k = 0; k < parts.length; k++) {
        var pair = parts[k].split(':');
        if (pair.length === 2) {
          el.setAttribute(pair[0].trim(), t(pair[1].trim()));
        }
      }
    }

    var phEls = document.querySelectorAll('[data-i18n-placeholder]');
    for (var p = 0; p < phEls.length; p++) {
      var el = phEls[p];
      var key = el.getAttribute('data-i18n-placeholder');
      if (key) el.placeholder = t(key);
    }

    // Update page lang attribute
    document.documentElement.lang = getLang();
  }

  window.i18n = {
    t: t,
    translatePage: translatePage,
    getLang: getLang,
    strings: strings,
  };
})();
