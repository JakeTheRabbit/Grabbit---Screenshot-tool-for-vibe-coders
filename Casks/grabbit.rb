cask "grabbit" do
  arch arm: "aarch64", intel: "x64"

  version "2.0.17"
  sha256 arm:   "4df7ec1f767fd1d56dfa392c13fe14d36abae9717dfd3e7dfacf978b3b23c62e",
         intel: "45b3bf1e25c40eb3c4e6a57a56eef6771aed1a29f43517458af3c95834cdcd1b"

  url "https://github.com/JakeTheRabbit/Grabbit---Screenshot-tool-for-vibe-coders/releases/download/v#{version}/Grabbit_#{version}_#{arch}.dmg"
  name "Grabbit"
  desc "Screenshots and screen recordings, straight to the clipboard"
  homepage "https://jaketherabbit.github.io/Grabbit---Screenshot-tool-for-vibe-coders/"

  depends_on macos: ">= :ventura"

  app "Grabbit.app"

  zap trash: [
    "~/Library/Application Support/app.grabbit",
    "~/Library/Caches/app.grabbit",
    "~/Library/Logs/app.grabbit",
  ]

  caveats <<~EOS
    Grabbit isn't signed with an Apple certificate yet. The first time, right-click
    Grabbit in Applications and choose Open. Then allow Screen Recording (and
    Microphone) in System Settings → Privacy & Security.
    Recording needs ffmpeg: brew install ffmpeg
  EOS
end
