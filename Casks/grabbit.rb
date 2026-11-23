cask "grabbit" do
  arch arm: "aarch64", intel: "x64"

  version "2.0.20"
  sha256 arm:   "6a83a6a4d48fcf81c74feba4c57d81c7f0928088e1367b0db32c9891a75c979b",
         intel: "9c46698f165d6953f104c271f3ba6c75bd283020c5aefaae85ef5b610a9c4f9a"

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
