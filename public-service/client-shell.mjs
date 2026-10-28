export function publicClient(userAgent=''){
 const native=/ReadingIslandAndroid\/(\d+)/.exec(userAgent);
 return {android:!!native||(/Android/i.test(userAgent)&&/\bwv\b/i.test(userAgent)),updates:!!native&&Number(native[1])>=3};
}
// User-Agent selects presentation only; account permissions remain server-verified.
export function renderPublicShell(html,userAgent){
 const client=publicClient(userAgent);
 return client.android?html.replace('<body>',`<body class="client-android"${client.updates?' data-native-updates="true"':''}>`):html;
}
