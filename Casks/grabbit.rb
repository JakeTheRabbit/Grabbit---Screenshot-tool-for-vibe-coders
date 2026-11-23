cask "grabbit" do
  arch arm: "aarch64", intel: "x64"

  version "2.0.21"
  sha256 arm:   "c5f028e4a9a228d46f46b5b0d55547c5713c78b7b2aa34e8535b782dfa3f093d",
         intel: "80a4cbc46c479c224b791e95fb212579b8ce0632a6ec1af56551beae5d7f5468"

  url "https://github.com/JakeTheRabbit/Grabbit---Screenshot-tool-for-vibe-coders/releases/download/v#{version}/Grabbit_#{version}_#{arch}.dmg"
  name "Grabbit"
  desc "Screenshots and screen recordings, straight to the clipboard"
  homepage "https://jaketherabbit.github.io/Grabbit---Screenshot-tool-for-vibe-coders/"

  depends_on macos: ">= :ventura"

  app "Grabbit.app"

  # Not notarised by Apple yet, so clear the download flag that makes macOS block it.
  postflight do
    system_command "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "#{appdir}/Grabbit.app"]
  end

  zap trash: [
    "~/Library/Application Support/app.grabbit",
    "~/Library/Caches/app.grabbit",
    "~/Library/Logs/app.grabbit",
  ]

  caveats <<~EOS
    Allow Screen Recording (and Microphone) for Grabbit in
    System Settings → Privacy & Security.
    Recording needs ffmpeg: brew install ffmpeg
  EOS
end
