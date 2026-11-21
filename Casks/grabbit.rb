cask "grabbit" do
  arch arm: "aarch64", intel: "x64"

  version "2.0.18"
  sha256 arm:   "0181481d754187986182785cf5a0807444fabbc83e941f978c98527f9a12bee5",
         intel: "0c4d5399e79b9028c65157415a2b445f55786fe5f4cd10760e3da1bb2d05f1b9"

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
