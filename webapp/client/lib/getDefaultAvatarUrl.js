import { stringToColor } from "./stringToColor";

export function getDefaultAvatarUrl(email) {
  const color = stringToColor(email);
  const svg = `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
  <g id="avatar" transform="translate(-1407 -182)">
  <circle cx="15" cy="15" r="15" transform="translate(1408 183)" fill="${color}" stroke="#333" stroke-linecap="round" stroke-linejoin="round" stroke-width="0.9"></circle>
  <circle cx="4.565" cy="4.565" r="4.565" transform="translate(1418.435 192.13)" fill="#ffffff" stroke="#333" stroke-miterlimit="10" stroke-width="0.9"></circle>
  <path d="M1423,213a14.928,14.928,0,0,0,9.4-3.323,9.773,9.773,0,0,0-18.808,0A14.928,14.928,0,0,0,1423,213Z" fill="#ffffff" stroke="#333" stroke-miterlimit="10" stroke-width="0.9"></path>
  </g></svg>`;
  const svgDataBase64 = btoa(unescape(encodeURIComponent(svg)));
  return `data:image/svg+xml;charset=utf-8;base64,${svgDataBase64}`;
}
