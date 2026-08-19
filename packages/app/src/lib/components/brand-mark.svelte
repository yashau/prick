<script lang="ts">
  /**
   * The prick mark.
   *
   * A copy of `assets/brand/logo.svg` in this repository, facet for facet and in
   * the same order: the mark is built from overlapping shapes, so paint order is
   * what produces the shading. That file already runs tone by tone, which is the
   * only reason the three `<g>` elements below are faithful to it -- they are a
   * shorthand for the per-path fills, NOT a regrouping. A facet added later
   * belongs at its original index, even if that splits a group.
   *
   * Inline rather than an `<img>` so it costs no request and renders with the
   * first paint of the sidebar. The three fills are literal brand values, not
   * theme tokens: the mark is the same colour in both themes, and it is legible
   * on either background, which is the same reason `packages/docs` points its
   * light and dark logo at one file.
   *
   * Decorative here. Every place it appears sits beside the word "prick", so
   * naming it again would make a screen reader say the name twice.
   */
  let { class: className = 'size-8' }: { class?: string } = $props();
</script>

<svg
  class={className}
  viewBox="8 7 619 1199"
  xmlns="http://www.w3.org/2000/svg"
  aria-hidden="true"
  focusable="false"
>
  <g fill="#c8f93a">
    <path d="M627,431L461,548L311,768L466,621L627,431Z" />
    <path d="M500,349L363,444L245,537L299,662L312,601L363,539L449,422L500,349Z" />
    <path
      d="M603,169L381,261L217,362L97,291L156,431L8,571L124,764L74,801L172,854L274,1062L317,1206L319,943L591,551L280,848L133,568L603,169Z"
    />
    <path d="M277,7L236,235L274,306L361,254L277,7Z" />
  </g>
  <g fill="#238112">
    <path d="M77,802L169,851L155,823L148,814L77,802Z" />
    <path d="M589,555L382,798L311,913L278,852L317,1205L319,942L589,555Z" />
    <path d="M604,459L486,566L466,620L604,459Z" />
    <path d="M465,399L299,562L299,658L312,601L366,536L465,399Z" />
    <path d="M164,331L186,383L188,395L216,363L164,331Z" />
    <path d="M600,172L327,345L105,588L210,790L276,846L132,568L600,172Z" />
    <path d="M278,10L294,212L361,253L278,10Z" />
  </g>
  <g fill="#8edc20">
    <path d="M210,791L314,1189L277,852L311,912L386,793L279,849L210,791Z" />
    <path d="M8,571L126,766L105,597L107,593L104,589L108,584L97,585L8,571Z" />
    <path d="M490,561L449,600L312,767L465,622L485,566L490,561Z" />
    <path d="M245,537L299,661L298,562L327,533L299,561L245,537Z" />
    <path d="M152,416L158,428L167,418L152,416Z" />
    <path d="M333,341L321,346L225,366L223,452L326,345L333,341Z" />
    <path d="M361,254L293,212L293,209L275,305L361,254Z" />
  </g>
</svg>
