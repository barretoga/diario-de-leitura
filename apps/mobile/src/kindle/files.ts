import * as DocumentPicker from "expo-document-picker";
import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";
import { MAX_CLIPPINGS_BYTES, parseClippings } from "./parser";

export async function pickClippings() {
  const result = await DocumentPicker.getDocumentAsync({ type: "*/*", multiple: false, copyToCacheDirectory: true });
  if (result.canceled) return null;
  const asset = result.assets[0], file = new File(asset.uri);
  if ((asset.size ?? 0) > MAX_CLIPPINGS_BYTES || file.size > MAX_CLIPPINGS_BYTES) throw new Error("Escolha um arquivo de até 10 MB.");
  return { name: asset.name, parsed: await parseClippings(await file.text(), text => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text)) };
}
