import AudioCaptureCore
import Foundation
func runDelayProbe() {


// Same synth as the bench
final class Shaper { var y1: Float=0,y2: Float=0; var g: SeededG
  init(seed: UInt64){ g = SeededG(seed: seed) }
  func step(_ t: Double) -> Float { let f = 350.0 + 250.0*sin(0.7*t) + 180.0*sin(1.9*t)
    let r = Float(exp(-2.0*Double.pi*f/48000.0)); let x = Float.random(in: -1...1, using: &g)
    let v = x*(1-r) + 2*r*0.7*y1 - r*r*y2; y2=y1; y1=v; return v } }
struct SeededG: RandomNumberGenerator { var s: UInt64; init(seed: UInt64){s = seed &+ 0x9E3779B97F4A7C15}
  mutating func next() -> UInt64 { s = s &* 6364136223846793005 &+ 1442695040888963407; return s } }

var gen = SeededG(seed: 7)
var far: [Float] = []
var near: [Float] = []
let rate = 48000
let delaySamples = rate * 24 / 1000
let total = 4 * rate
var shaper = Shaper(seed: 7)
for i in 0..<total {
  let t = Double(i)/Double(rate)
  let talking = t.truncatingRemainder(dividingBy: 2.0) < 1.5
  let env = 0.5 + 0.5*sin(2.0 * Double.pi*3.5*t)
  let f: Float = talking ? shaper.step(t)*Float(env)*0.5 : 0
  far.append(f)
  near.append(f * 0.35)
}
// shift near by 24 ms (the echo path under test)
let shift = 24 * rate / 1000
var delayed = [Float](repeating: 0, count: shift) + near
near = delayed

var est = AcousticDelayEstimator()
// decimate both to 16k
var rd = Decimator48to16(); var nd = Decimator48to16()
var produced = false
var offset = 0
while offset + 960 <= total {
  let r16 = rd.decimate(Array(far[offset..<offset+960]))
  let n16 = nd.decimate(Array(near[offset..<offset+960]))
  if est.feed(reference: r16, near: n16) {
    print("estimate at \(offset/48) ms: \(est.delayHintMs) ms")
    produced = true
  }
  offset += 960
}
if !produced { print("NO ESTIMATE PRODUCED") }

}