/**
 * pi-hwp 손파서(readZip/readCfb/extractHwpx/extractHwp5) 유닛 테스트.
 *
 * 픽스처는 바이너리 파일 커밋 없이 테스트 코드에서 직접 조립한다 —
 * 실제 .hwp/.hwpx 파일 검증은 pi -e 수동 확인으로 보완한다.
 *
 * 실행: node --experimental-strip-types --test packages/pi-hwp/test/unit.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32, deflateRawSync } from "node:zlib";
import {
  decodeParaText,
  extractHwp5,
  extractHwpx,
  readCfb,
  readZip,
} from "../extensions/read-hwp.ts";

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

// ---------------------------------------------------------------- CFB 픽스처 조립

const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;

function dirEntry(name, type, { left = -1, right = -1, child = -1, start = ENDOFCHAIN, size = 0 } = {}) {
  const b = Buffer.alloc(128);
  const nameBuf = Buffer.from(name, "utf16le");
  nameBuf.copy(b, 0);
  b.writeUInt16LE(nameBuf.length + 2, 64); // 이름 길이 (NUL 포함, 바이트)
  b[66] = type; // 1=storage, 2=stream, 5=root
  b.writeInt32LE(left, 68);
  b.writeInt32LE(right, 72);
  b.writeInt32LE(child, 76);
  b.writeUInt32LE(start, 116);
  b.writeUInt32LE(size, 120);
  return b;
}

/**
 * 최소 HWP 5.x CFB v3 컨테이너. 섹터 배치: 0=FAT, 1=디렉토리, 2=FileHeader, 3=Section0.
 * mini cutoff는 0으로 둬 모든 스트림이 일반 FAT 체인을 탄다.
 */
function buildHwpCfb({ flags = 0, section = Buffer.alloc(0), sectorShift = 9 } = {}) {
  const header = Buffer.alloc(512);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(3, 26); // major version
  header.writeUInt16LE(0xfffe, 28); // byte order
  header.writeUInt16LE(sectorShift, 30);
  header.writeUInt16LE(6, 32); // mini sector shift
  header.writeUInt32LE(1, 44); // FAT 섹터 수
  header.writeUInt32LE(1, 48); // 디렉토리 시작 섹터
  header.writeUInt32LE(0, 56); // mini stream cutoff
  header.writeUInt32LE(ENDOFCHAIN, 60); // miniFAT 없음
  header.writeUInt32LE(ENDOFCHAIN, 68); // DIFAT 체인 없음
  for (let i = 0; i < 109; i++) header.writeUInt32LE(0xffffffff, 76 + i * 4);
  header.writeUInt32LE(0, 76); // FAT은 sector 0

  const fat = Buffer.alloc(512, 0xff); // 미사용 엔트리 전부 FREESECT
  fat.writeUInt32LE(FATSECT, 0); // sector 0 = FAT 자신
  fat.writeUInt32LE(ENDOFCHAIN, 4); // sector 1 = 디렉토리
  fat.writeUInt32LE(ENDOFCHAIN, 8); // sector 2 = FileHeader
  fat.writeUInt32LE(ENDOFCHAIN, 12); // sector 3 = Section0

  const dir = Buffer.concat([
    dirEntry("Root Entry", 5, { child: 1 }),
    dirEntry("FileHeader", 2, { right: 2, start: 2, size: 256 }),
    dirEntry("BodyText", 1, { child: 3 }),
    dirEntry("Section0", 2, { start: 3, size: section.length }),
  ]);

  const fileHeader = Buffer.alloc(512);
  fileHeader.write("HWP Document File", 0, "latin1");
  fileHeader.writeUInt32LE(flags, 36);

  const sectionSector = Buffer.alloc(512);
  section.copy(sectionSector, 0);

  return Buffer.concat([header, fat, dir, fileHeader, sectionSector]);
}

/** HWPTAG_PARA_TEXT(67) 레코드: 4바이트 헤더 + UTF-16LE 페이로드 */
function paraTextRecord(text) {
  const payload = Buffer.from(text, "utf16le");
  const h = Buffer.alloc(4);
  h.writeUInt32LE((67 | (payload.length << 20)) >>> 0, 0);
  return Buffer.concat([h, payload]);
}

// ---------------------------------------------------------------- readZip

test("readZip: stored/deflate 혼합과 한글 엔트리명 왕복", () => {
  const zip = buildZip([
    { name: "mimetype", data: "application/hwp+zip", method: 0 },
    { name: "Contents/한글문서.xml", data: "<hp:t>내용</hp:t>" },
  ]);
  const entries = readZip(zip);
  assert.equal(entries.size, 2);
  assert.equal(entries.get("mimetype").toString(), "application/hwp+zip");
  assert.equal(entries.get("Contents/한글문서.xml").toString(), "<hp:t>내용</hp:t>");
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

test("readZip: ZIP이 아닌 입력은 에러", () => {
  assert.throws(() => readZip(Buffer.alloc(64)), /not a zip file/);
});

// ---------------------------------------------------------------- extractHwpx

test("extractHwpx: 문단과 표를 마크다운으로 추출", () => {
  const xml =
    "<hml><hp:p><hp:t>첫 문단</hp:t></hp:p>" +
    "<hp:tbl><hp:tr>" +
    "<hp:tc><hp:p><hp:t>A</hp:t></hp:p></hp:tc>" +
    "<hp:tc><hp:p><hp:t>B</hp:t></hp:p></hp:tc>" +
    "</hp:tr></hp:tbl></hml>";
  const zip = buildZip([{ name: "Contents/section0.xml", data: xml }]);
  assert.equal(extractHwpx(zip), "첫 문단\n| A | B |");
});

test("extractHwpx: section*.xml이 없으면 에러", () => {
  const zip = buildZip([{ name: "mimetype", data: "x", method: 0 }]);
  assert.throws(() => extractHwpx(zip), /no Contents\/section/);
});

// ---------------------------------------------------------------- readCfb

test("readCfb: 스트림 경로와 내용을 정확히 복원", () => {
  const section = paraTextRecord("본문");
  const streams = readCfb(buildHwpCfb({ section }));
  assert.deepEqual([...streams.keys()].sort(), ["BodyText/Section0", "FileHeader"]);
  assert.equal(streams.get("FileHeader").length, 256);
  assert.ok(streams.get("FileHeader").toString("latin1", 0, 17).startsWith("HWP Document File"));
  assert.deepEqual(streams.get("BodyText/Section0"), section);
});

test("readCfb: 순환 FAT 체인은 OOM 크래시 대신 명시적 에러", () => {
  const doc = buildHwpCfb({ section: paraTextRecord("x") });
  doc.writeUInt32LE(1, 512 + 4); // FAT[1](디렉토리 체인)을 자기 참조로 패치
  assert.throws(() => readCfb(doc), /cyclic sector chain/);
});

test("readCfb: v4(4096바이트 섹터)는 오독 대신 명시적 에러", () => {
  assert.throws(() => readCfb(buildHwpCfb({ sectorShift: 12 })), /only v3/);
});

// ---------------------------------------------------------------- extractHwp5

test("extractHwp5: PARA_TEXT 레코드에서 문단 텍스트 추출", () => {
  const section = Buffer.concat([paraTextRecord("안녕 HWP"), paraTextRecord("둘째 문단")]);
  assert.equal(extractHwp5(buildHwpCfb({ section })), "안녕 HWP\n둘째 문단");
});

test("extractHwp5: 암호 문서(flags bit 1)는 명시적 에러", () => {
  assert.throws(() => extractHwp5(buildHwpCfb({ flags: 0b10 })), /password-protected/);
});

test("extractHwp5: 배포용 문서(flags bit 2)는 명시적 에러", () => {
  assert.throws(() => extractHwp5(buildHwpCfb({ flags: 0b100 })), /distribution-only/);
});

// ---------------------------------------------------------------- decodeParaText

test("decodeParaText: 제어문자 스킵과 탭/개행 변환", () => {
  // [탭(9, 8워드)] "AB" [개행(10, 1워드)] "C"
  const words = [9, 0, 0, 0, 0, 0, 0, 0, 0x41, 0x42, 10, 0x43];
  const payload = Buffer.alloc(words.length * 2);
  words.forEach((w, i) => payload.writeUInt16LE(w, i * 2));
  assert.equal(decodeParaText(payload), "\tAB\nC");
});
