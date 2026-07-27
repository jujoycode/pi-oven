/**
 * pi-odt 손파서(readZip/extractOdt) 유닛 테스트.
 *
 * 픽스처는 바이너리 파일 커밋 없이 테스트 코드에서 직접 조립한다 —
 * 실제 .odt 파일 검증은 pi -e 수동 확인으로 보완한다.
 *
 * 실행: node --experimental-strip-types --test packages/pi-odt/test/unit.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32, deflateRawSync } from "node:zlib";
import { extractOdt, extractOdtImages, readZip } from "../extensions/read-odt.ts";

// ---------------------------------------------------------------- ZIP 픽스처 조립

/**
 * 최소 ZIP 조립기. files: { name, data, method?(기본 8), gpFlags?, badCrc? }[]
 */
function buildZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const f of files) {
    const data = Buffer.from(f.data ?? "");
    const nameBuf = Buffer.from(f.name, "utf8");
    const method = f.method ?? 8;
    const comp = method === 8 ? deflateRawSync(data) : data;
    const crc = f.badCrc ? (crc32(data) ^ 0xffffffff) >>> 0 : crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(f.gpFlags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    localParts.push(local, nameBuf, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(f.gpFlags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralBuf, eocd]);
}

// ---------------------------------------------------------------- readZip

test("readZip: stored/deflate 혼합과 한글 엔트리명 왕복", () => {
  const zip = buildZip([
    { name: "mimetype", data: "application/vnd.oasis.opendocument.text", method: 0 },
    { name: "내부/문서.xml", data: "<text:p>내용</text:p>" },
  ]);
  const entries = readZip(zip);
  assert.equal(entries.size, 2);
  assert.equal(entries.get("mimetype").toString(), "application/vnd.oasis.opendocument.text");
  assert.equal(entries.get("내부/문서.xml").toString(), "<text:p>내용</text:p>");
});

test("readZip: 암호화 엔트리(GP bit 0)는 명시적 에러", () => {
  const zip = buildZip([{ name: "content.xml", data: "x", gpFlags: 0x1 }]);
  assert.throws(() => readZip(zip), /encrypted zip entry/);
});

test("readZip: 비지원 압축 method는 명시적 에러", () => {
  const zip = buildZip([{ name: "content.xml", data: "x", method: 99 }]);
  assert.throws(() => readZip(zip), /unsupported zip compression method 99/);
});

test("readZip: CRC 불일치는 무음 통과 대신 명시적 에러", () => {
  const zip = buildZip([{ name: "content.xml", data: "damaged", method: 0, badCrc: true }]);
  assert.throws(() => readZip(zip), /CRC mismatch/);
});

// ---------------------------------------------------------------- extractOdt

test("extractOdt: 제목·문단·공백류·표를 마크다운으로 추출", () => {
  const content =
    "<office:document-content><office:body><office:text>" +
    '<text:h text:outline-level="2">제목</text:h>' +
    "<text:p>본문 첫<text:line-break/>둘째 줄</text:p>" +
    '<text:p>공백<text:s text:c="3"/>탭<text:tab/>끝</text:p>' +
    "<table:table><table:table-row>" +
    "<table:table-cell><text:p>이름</text:p></table:table-cell>" +
    "<table:table-cell><text:p>값</text:p></table:table-cell>" +
    "</table:table-row></table:table>" +
    "</office:text></office:body></office:document-content>";
  const zip = buildZip([{ name: "content.xml", data: content }]);
  assert.equal(
    extractOdt(zip),
    "## 제목\n본문 첫\n둘째 줄\n공백   탭\t끝\n| 이름 | 값 |",
  );
});

test("extractOdt: XML 엔티티 디코드", () => {
  const content = "<office:text><text:p>&lt;a&gt; &amp; &#xac00;</text:p></office:text>";
  const zip = buildZip([{ name: "content.xml", data: content }]);
  assert.equal(extractOdt(zip), "<a> & 가");
});

test("extractOdt: content.xml이 없으면 에러", () => {
  const zip = buildZip([{ name: "mimetype", data: "x", method: 0 }]);
  assert.throws(() => extractOdt(zip), /no content\.xml/);
});

// ---------------------------------------------------------------- extractOdtImages

test("extractOdtImages: Pictures/ 항목만 이미지로 수집", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const zip = buildZip([
    { name: "content.xml", data: "<office:text/>" },
    { name: "Pictures/img1.png", data: png, method: 0 },
  ]);
  const images = extractOdtImages(zip);
  assert.equal(images.length, 1);
  assert.equal(images[0].name, "Pictures/img1.png");
  assert.deepEqual(images[0].data, png);
});
