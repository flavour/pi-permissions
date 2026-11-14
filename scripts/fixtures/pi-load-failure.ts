// Deliberate factory failure, loaded only by the opt-in automated host smoke.
export default function (): never {
  throw new Error("automated smoke: deliberate extension load failure");
}
