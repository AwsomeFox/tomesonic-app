package com.audiobookshelf.app.player.ui

import android.content.Context
import android.util.AttributeSet
import android.view.LayoutInflater
import android.widget.LinearLayout
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.findViewTreeLifecycleOwner
import androidx.lifecycle.findViewTreeViewModelStoreOwner
import androidx.lifecycle.lifecycleScope
import com.audiobookshelf.app.databinding.PlaybackControlsBinding
import com.audiobookshelf.app.player.viewmodel.PlaybackViewModel
import kotlinx.coroutines.launch
import android.util.Log

/**
 * Modern playback controls component that uses the new reactive Media3 architecture
 */
class PlaybackControlsView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : LinearLayout(context, attrs, defStyleAttr) {

    companion object {
        private const val TAG = "PlaybackControlsView"
    }

    private lateinit var binding: PlaybackControlsBinding
    private lateinit var viewModel: PlaybackViewModel

    init {
        initializeView()
    }

    private fun initializeView() {
        // Inflate the layout
        val inflater = LayoutInflater.from(context)
        binding = PlaybackControlsBinding.inflate(inflater, this, true)

        // Setup click listeners
        setupClickListeners()

        // Initialize ViewModel when attached to window
        if (isAttachedToWindow) {
            initializeViewModel()
        }
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        initializeViewModel()
    }

    private fun initializeViewModel() {
        try {
            val viewModelStoreOwner = findViewTreeViewModelStoreOwner()
            if (viewModelStoreOwner != null) {
                viewModel = ViewModelProvider(viewModelStoreOwner)[PlaybackViewModel::class.java]
                observeViewModel()
                Log.d(TAG, "PlaybackViewModel initialized successfully")
            } else {
                Log.e(TAG, "ViewModelStoreOwner not found")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to initialize ViewModel: ${e.message}")
        }
    }

    private fun setupClickListeners() {
        binding.apply {
            // Main playback controls
            buttonPlayPause.setOnClickListener {
                if (::viewModel.isInitialized) {
                    val currentState = viewModel.uiState.value
                    if (currentState.isPlaying) {
                        viewModel.pause()
                    } else {
                        viewModel.play()
                    }
                }
            }

            // Chapter navigation
            buttonPrevious.setOnClickListener {
                if (::viewModel.isInitialized) {
                    viewModel.seekToPrevious()
                }
            }

            buttonNext.setOnClickListener {
                if (::viewModel.isInitialized) {
                    viewModel.seekToNext()
                }
            }

            // Skip controls
            buttonSkipBackward.setOnClickListener {
                if (::viewModel.isInitialized) {
                    viewModel.skipBackward()
                }
            }

            buttonSkipForward.setOnClickListener {
                if (::viewModel.isInitialized) {
                    viewModel.skipForward()
                }
            }

            // Smart skip controls (combines time and chapter navigation)
            buttonSmartSkipBackward.setOnClickListener {
                if (::viewModel.isInitialized) {
                    viewModel.smartSkipBackward()
                }
            }

            buttonSmartSkipForward.setOnClickListener {
                if (::viewModel.isInitialized) {
                    viewModel.smartSkipForward()
                }
            }

            // Playback speed
            buttonPlaybackSpeed.setOnClickListener {
                if (::viewModel.isInitialized) {
                    showPlaybackSpeedDialog()
                }
            }

            // Progress bar seeking
            progressBar.setOnSeekBarChangeListener(object : android.widget.SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(seekBar: android.widget.SeekBar?, progress: Int, fromUser: Boolean) {
                    if (fromUser && ::viewModel.isInitialized) {
                        val duration = viewModel.uiState.value.durationMs
                        val newPosition = (progress / 100f * duration).toLong()
                        updateTimeTexts(newPosition, duration)
                    }
                }

                override fun onStartTrackingTouch(seekBar: android.widget.SeekBar?) {
                    // User started seeking
                }

                override fun onStopTrackingTouch(seekBar: android.widget.SeekBar?) {
                    if (::viewModel.isInitialized) {
                        val progress = seekBar?.progress ?: 0
                        val duration = viewModel.uiState.value.durationMs
                        val newPosition = (progress / 100f * duration).toLong()
                        viewModel.seekTo(newPosition)
                    }
                }
            })
        }
    }

    private fun observeViewModel() {
        val lifecycleOwner = findViewTreeLifecycleOwner()
        if (lifecycleOwner != null) {
            // Observe playback state
            lifecycleOwner.lifecycleScope.launch {
                viewModel.uiState.collect { state ->
                    updatePlaybackControls(state)
                }
            }

            // Observe chapter state
            lifecycleOwner.lifecycleScope.launch {
                viewModel.chapterState.collect { chapterState ->
                    updateChapterInfo(chapterState)
                }
            }
        }
    }

    private fun updatePlaybackControls(state: com.audiobookshelf.app.player.viewmodel.PlaybackUiState) {
        binding.apply {
            // Update play/pause button
            buttonPlayPause.setImageResource(
                if (state.isPlaying) {
                    android.R.drawable.ic_media_pause
                } else {
                    android.R.drawable.ic_media_play
                }
            )

            // Update loading state
            progressBarLoading.visibility = if (state.isBuffering) {
                android.view.View.VISIBLE
            } else {
                android.view.View.GONE
            }

            // Update progress
            if (state.durationMs > 0) {
                val progressPercent = (state.positionMs.toFloat() / state.durationMs * 100).toInt()
                progressBar.progress = progressPercent

                // Update buffered progress
                progressBar.secondaryProgress = state.bufferedPercentage.toInt()
            }

            // Update time texts
            updateTimeTexts(state.positionMs, state.durationMs)

            // Update metadata
            textTitle.text = state.title
            textArtist.text = state.artist

            // Update control availability
            buttonPrevious.isEnabled = state.canSeekToPrevious
            buttonNext.isEnabled = state.canSeekToNext
            buttonSkipBackward.isEnabled = state.canSkipBackward
            buttonSkipForward.isEnabled = state.canSkipForward

            // Update playback speed
            buttonPlaybackSpeed.text = "${state.playbackSpeed}x"

            // Load artwork if available
            state.artworkUri?.let { uri ->
                // Use Glide or similar library to load artwork
                // Glide.with(context).load(uri).into(imageArtwork)
            }
        }
    }

    private fun updateChapterInfo(chapterState: com.audiobookshelf.app.player.viewmodel.ChapterUiState) {
        binding.apply {
            if (chapterState.totalChapters > 1) {
                // Show chapter info
                textChapterInfo.visibility = android.view.View.VISIBLE
                textChapterInfo.text = "Chapter ${chapterState.currentChapterIndex + 1} of ${chapterState.totalChapters}"

                textChapterTitle.visibility = android.view.View.VISIBLE
                textChapterTitle.text = chapterState.chapterTitle

                // Update chapter progress if available
                if (chapterState.chapterProgress > 0) {
                    progressBarChapter.visibility = android.view.View.VISIBLE
                    progressBarChapter.progress = (chapterState.chapterProgress * 100).toInt()
                } else {
                    progressBarChapter.visibility = android.view.View.GONE
                }
            } else {
                // Hide chapter-specific UI
                textChapterInfo.visibility = android.view.View.GONE
                textChapterTitle.visibility = android.view.View.GONE
                progressBarChapter.visibility = android.view.View.GONE
            }
        }
    }

    private fun updateTimeTexts(positionMs: Long, durationMs: Long) {
        binding.apply {
            textCurrentTime.text = formatTime(positionMs)
            textDuration.text = formatTime(durationMs)
            textRemaining.text = "-${formatTime(durationMs - positionMs)}"
        }
    }

    private fun formatTime(ms: Long): String {
        val totalSeconds = ms / 1000
        val hours = totalSeconds / 3600
        val minutes = (totalSeconds % 3600) / 60
        val seconds = totalSeconds % 60

        return if (hours > 0) {
            String.format("%d:%02d:%02d", hours, minutes, seconds)
        } else {
            String.format("%d:%02d", minutes, seconds)
        }
    }

    private fun showPlaybackSpeedDialog() {
        // Implementation for playback speed selection dialog
        val speeds = arrayOf("0.5x", "0.75x", "1.0x", "1.25x", "1.5x", "1.75x", "2.0x")
        val currentSpeed = viewModel.uiState.value.playbackSpeed
        val currentIndex = speeds.indexOfFirst { it.replace("x", "").toFloat() == currentSpeed }

        android.app.AlertDialog.Builder(context)
            .setTitle("Playback Speed")
            .setSingleChoiceItems(speeds, currentIndex) { dialog, which ->
                val selectedSpeed = speeds[which].replace("x", "").toFloat()
                viewModel.setPlaybackSpeed(selectedSpeed)
                dialog.dismiss()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    /**
     * Public method to show chapter list dialog
     */
    fun showChapterList() {
        if (!::viewModel.isInitialized) return

        val chapterState = viewModel.chapterState.value
        if (chapterState.chapters.isEmpty()) return

        val chapterTitles = chapterState.chapters.map { it.title }.toTypedArray()
        val currentIndex = chapterState.currentChapterIndex

        android.app.AlertDialog.Builder(context)
            .setTitle("Chapters")
            .setSingleChoiceItems(chapterTitles, currentIndex) { dialog, which ->
                viewModel.seekToChapter(which)
                dialog.dismiss()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }
}
