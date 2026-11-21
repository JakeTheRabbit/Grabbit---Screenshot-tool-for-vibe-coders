cask "grabbit" do
  arch arm: "aarch64", intel: "x64"

  version "@V@"
  sha256 arm:   "@SHA_ARM@",
         intel: "@SHA_X64@"

  url "https://github.com/@REPO@/releases/download/v#{version}/Grabbit_#{version}_#{arch}.dmg"
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
